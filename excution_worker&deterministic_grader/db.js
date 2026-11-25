import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "grader.db");

export function openGraderDb(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      statement TEXT NOT NULL DEFAULT '',
      default_timeout_ms INTEGER NOT NULL DEFAULT 3000,
      max_output_bytes INTEGER NOT NULL DEFAULT 1048576,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
      case_order INTEGER NOT NULL,
      name TEXT NOT NULL,
      stdin TEXT NOT NULL DEFAULT '',
      expected_output TEXT NOT NULL DEFAULT '',
      points REAL NOT NULL DEFAULT 20,
      timeout_ms INTEGER,
      is_hidden INTEGER NOT NULL DEFAULT 1,
      UNIQUE(problem_id, case_order)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      problem_id INTEGER NOT NULL REFERENCES problems(id),
      language TEXT NOT NULL CHECK (language IN ('c', 'python')),
      source_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      verdict TEXT CHECK (verdict IN ('AC', 'WA', 'CE', 'RE', 'TLE', 'MLE')),
      score REAL NOT NULL DEFAULT 0,
      max_score REAL NOT NULL DEFAULT 100,
      passed_count INTEGER NOT NULL DEFAULT 0,
      total_cases INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      compile_stderr TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS submission_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      test_case_id INTEGER REFERENCES test_cases(id),
      case_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('AC', 'WA', 'CE', 'RE', 'TLE', 'MLE')),
      points_earned REAL NOT NULL DEFAULT 0,
      max_points REAL NOT NULL DEFAULT 0,
      exit_code INTEGER,
      oom_killed INTEGER NOT NULL DEFAULT 0,
      stdout_truncated INTEGER NOT NULL DEFAULT 0,
      stderr_truncated INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      stdout TEXT,
      stderr TEXT
    );
  `);

  return db;
}

export function seedDefaultProblem(db) {
  const slug = "max-of-n";
  const existing = db
    .prepare("SELECT id FROM problems WHERE slug = ?")
    .get(slug);

  if (existing) {
    return existing.id;
  }

  const seedTxn = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO problems (slug, title, statement, default_timeout_ms, max_output_bytes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        slug,
        "Maximum of N Integers",
        "Given N (1 <= N <= 100000) followed by N integers, print the maximum value.",
        3000,
        1048576
      );

    const problemId = Number(info.lastInsertRowid);
    const insertCase = db.prepare(
      `INSERT INTO test_cases
         (problem_id, case_order, name, stdin, expected_output, points, timeout_ms, is_hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const cases = [
      [1, "Small positive numbers", "5\n3 9 1 7 4\n", "9", 20, 3000, 0],
      [2, "Single element", "1\n42\n", "42", 20, 3000, 0],
      [3, "All negative numbers", "4\n-15 -3 -99 -1\n", "-1", 20, 3000, 1],
      [4, "Zeros and duplicates", "6\n0 0 8 8 2 0\n", "8", 20, 3000, 1],
      [5, "Large values near 32-bit int", "3\n1000000000 2000000000 1500000000\n", "2000000000", 20, 3000, 1],
    ];

    for (const row of cases) {
      insertCase.run(problemId, ...row);
    }

    return problemId;
  });

  return seedTxn();
}

export function getProblemWithCases(db, slug) {
  const problem = db
    .prepare("SELECT * FROM problems WHERE slug = ?")
    .get(slug);
  if (!problem) return null;

  const testCases = db
    .prepare(
      `SELECT id, case_order, name, stdin, expected_output, points, timeout_ms
       FROM test_cases
       WHERE problem_id = ?
       ORDER BY case_order ASC`
    )
    .all(problem.id);

  return { problem, testCases };
}

export function createSubmission(db, { problemId, language, sourceCode }) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO submissions (id, problem_id, language, source_code, status)
     VALUES (?, ?, ?, ?, 'running')`
  ).run(id, problemId, language, sourceCode);
  return id;
}

export function saveGradingReport(db, submissionId, testCaseRows, report) {
  const saveTxn = db.transaction(() => {
    db.prepare(
      `UPDATE submissions
       SET status = 'completed',
           verdict = ?,
           score = ?,
           max_score = ?,
           passed_count = ?,
           total_cases = ?,
           elapsed_ms = ?,
           compile_stderr = ?,
           finished_at = datetime('now')
       WHERE id = ?`
    ).run(
      report.verdict,
      report.score,
      report.maxScore ?? 100,
      report.passedCount,
      report.totalCases,
      report.elapsedMs ?? 0,
      report.compileStderr ?? null,
      submissionId
    );

    db.prepare("DELETE FROM submission_cases WHERE submission_id = ?").run(
      submissionId
    );

    const insertCaseResult = db.prepare(
      `INSERT INTO submission_cases
         (submission_id, test_case_id, case_index, name, verdict,
          points_earned, max_points, exit_code, oom_killed,
          stdout_truncated, stderr_truncated, elapsed_ms, stdout, stderr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const c of report.cases ?? []) {
      const matchedDbCase = testCaseRows[c.index] ?? null;
      insertCaseResult.run(
        submissionId,
        matchedDbCase ? matchedDbCase.id : null,
        c.index,
        c.name,
        c.verdict,
        c.pointsEarned,
        c.maxPoints,
        c.exitCode ?? null,
        c.oomKilled ? 1 : 0,
        c.stdoutTruncated ? 1 : 0,
        c.stderrTruncated ? 1 : 0,
        c.elapsedMs ?? 0,
        c.stdout ?? null,
        c.stderr ?? null
      );
    }
  });

  saveTxn();
}
