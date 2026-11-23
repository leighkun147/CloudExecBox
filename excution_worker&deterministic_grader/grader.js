import { runSubmission } from "./excution_worker.js";
//a layer between the simulator testrunner and the actual excution worker.
function resolveCaseWeights(testCases) {
  const hasExplicitPoints = testCases.some(
    (tc) => typeof tc.points === "number" && Number.isFinite(tc.points)
  );

  if (!hasExplicitPoints) {
    const equalWeight = 100 / testCases.length;
    return testCases.map(() => equalWeight);
  }

  const rawWeights = testCases.map((tc) =>
    typeof tc.points === "number" && Number.isFinite(tc.points) && tc.points >= 0
      ? tc.points
      : 0
  );
  const sumWeights = rawWeights.reduce((acc, w) => acc + w, 0);

  if (sumWeights <= 0) {
    const equalWeight = 100 / testCases.length;
    return testCases.map(() => equalWeight);
  }

  // Normalize weights so total possible points equal 100 even if raw points don't sum to 100
  return rawWeights.map((w) => (w / sumWeights) * 100);
}

function determineOverallVerdict(caseResults) {
  if (caseResults.length === 0) {
    return "RE";
  }

  if (caseResults.every((r) => r.verdict === "AC")) {
    return "AC";
  }

  // Prioritize execution/resource errors if any case hit TLE, MLE, or RE
  for (const priority of ["TLE", "MLE", "RE"]) {
    const hit = caseResults.find((r) => r.verdict === priority);
    if (hit) return hit.verdict;
  }

  return "WA";
}

export async function gradeSubmission({
  language,
  sourceCode,
  testCases = [],
  timeoutMs = 3000,
  maxOutputBytes,
  baseWorkDir,
  stopOnFirstError = false,
}) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error("gradeSubmission requires a non-empty testCases array");
  }

  const weights = resolveCaseWeights(testCases);
  const caseResults = [];
  let earnedScore = 0;
  let totalElapsedMs = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const maxPoints = weights[i];
    const caseTimeoutMs =
      typeof tc.timeoutMs === "number" && tc.timeoutMs > 0
        ? tc.timeoutMs
        : timeoutMs;

    const res = await runSubmission({
      language,
      sourceCode,
      stdin: tc.stdin ?? "",
      expectedOutput: tc.expectedOutput ?? "",
      timeoutMs: caseTimeoutMs,
      ...(typeof maxOutputBytes === "number" ? { maxOutputBytes } : {}),
      ...(baseWorkDir ? { baseWorkDir } : {}),
    });

    totalElapsedMs += res.elapsedMs ?? 0;

    // Compilation failure applies to the whole submission immediately (0 / 100)
    if (res.verdict === "CE") {
      return {
        verdict: "CE",
        score: 0,
        maxScore: 100,
        passedCount: 0,
        totalCases: testCases.length,
        elapsedMs: totalElapsedMs,
        compileStderr: res.stderr,
        cases: [
          {
            index: i,
            name: tc.name ?? `Case ${i + 1}`,
            verdict: "CE",
            pointsEarned: 0,
            maxPoints: Number(maxPoints.toFixed(2)),
            exitCode: res.exitCode,
            oomKilled: false,
            stdoutTruncated: Boolean(res.stdoutTruncated),
            stderrTruncated: Boolean(res.stderrTruncated),
            elapsedMs: res.elapsedMs,
            stderr: res.stderr,
          },
        ],
      };
    }

    const passed = res.verdict === "AC";
    const pointsEarned = passed ? maxPoints : 0;
    if (passed) {
      earnedScore += maxPoints;
    }

    caseResults.push({
      index: i,
      name: tc.name ?? `Case ${i + 1}`,
      verdict: res.verdict,
      pointsEarned: Number(pointsEarned.toFixed(2)),
      maxPoints: Number(maxPoints.toFixed(2)),
      exitCode: res.exitCode,
      oomKilled: Boolean(res.oomKilled),
      stdoutTruncated: Boolean(res.stdoutTruncated),
      stderrTruncated: Boolean(res.stderrTruncated),
      elapsedMs: res.elapsedMs,
    });

    if (stopOnFirstError && !passed) {
      break;
    }
  }

  const finalScore = Number(
    Math.min(100, Math.max(0, earnedScore)).toFixed(2)
  );
  const passedCount = caseResults.filter((c) => c.verdict === "AC").length;
  const overallVerdict = determineOverallVerdict(caseResults);

  return {
    verdict: overallVerdict,
    score: finalScore,
    maxScore: 100,
    passedCount,
    totalCases: testCases.length,
    elapsedMs: totalElapsedMs,
    cases: caseResults,
  };
}