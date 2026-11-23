# Phase 2 Notes — Execution Worker & Deterministic Grader (`benchmark-server`)

## 1. Current Repository Layout on `benchmark-server`

After completing the runner images and hardening checks in `runners/`, Phase 2 organized the automated execution worker and simulated grading harness under `~/cloud-code-runner/excution_worker&deterministic_grader`:

```text
~/cloud-code-runner/
├── runners/
│   ├── Dockerfile.c
│   └── Dockerfile.python
└── excution_worker&deterministic_grader/
    ├── excution_worker.js
    ├── package.json
    └── testrunner.js
```

* **`runners/Dockerfile.c` & `Dockerfile.python`**: Hardened runner images executing untrusted workloads as non-root `UID 65534:65534` (`nobody`).
* **`excution_worker&deterministic_grader/excution_worker.js`**: The core worker and deterministic grading module (`runSubmission`) that automates compilation, hardened `docker run` execution, stream bounding, exit-code/OOM classification, and cleanup.
* **`excution_worker&deterministic_grader/testrunner.js`**: The simulated test harness driving `runSubmission` against representative test cases (`AC`, `WA`, `CE`, `TLE`, `MLE`, `RE`) without needing Redis, a database, or an HTTP API yet.
* **`excution_worker&deterministic_grader/package.json`**: Configures Node.js package metadata and module resolution (`"type": "module"`) for the worker directory.

---

## 2. Role of `package.json` & The Module Import Error We Fixed

### The Error Encountered
When running `node testrunner.js` on Node.js v18.19.1, Node threw a `SyntaxError` because `testrunner.js` used an ES module named import (`import { runSubmission } from "./runner.js"` / `./excution_worker.js`), while Node treated the `.js` file as CommonJS:

```text
SyntaxError: Named export 'runSubmission' not found. The requested module ... is a CommonJS module, which may not support all module.exports as named exports.
```

### What `package.json` Provided
Adding `"type": "module"` to `package.json` inside `excution_worker&deterministic_grader/` tells Node.js v18.19.1 to treat `.js` files in that directory as **ES Modules (`ESM`)** rather than falling back to CommonJS:

```json
{
  "type": "module"
}
```

With `"type": "module"` set:
1. `excution_worker.js` can cleanly export `runSubmission` using `export async function runSubmission(...)`.
2. `testrunner.js` can directly import `runSubmission` as a named ESM export (`import { runSubmission } from "./excution_worker.js"`), keeping imports explicit and consistent across the module boundary.

---

## 3. How `excution_worker.js` Was Designed & Why

`excution_worker.js` automates what was previously run manually in the terminal, turning a raw job object into a structured grading result.

### A. Inputs Accepted by `runSubmission`
Each call receives a self-contained job definition:
* `language`: `"c"` or `"python"` (mapped to `runner-c:latest` and `runner-python:latest`).
* `sourceCode`: Raw C or Python source code string.
* `stdin`: Optional standard input string fed into the container process.
* `expectedOutput`: Expected output string for grading `AC` vs. `WA`.
* `timeoutMs`: Wall-clock execution timeout in milliseconds (default `3000`).
* `maxOutputBytes`: Per-stream byte cap for `stdout` and `stderr` (default `1 MiB`).
* `baseWorkDir`: Base directory for per-job staging folders (under `os.tmpdir()/benchmark-jobs`).

### B. Ephemeral Per-Job Workspace & Two-Phase File Mounting
1. **Unique IDs per run:** Each execution generates a unique `jobId` and container name (`runner-job-${jobId}`) with its own directory `${baseWorkDir}/${jobId}` so concurrent or sequential submissions never overwrite one another's files.
2. **Compile pass (`:rw` for C only):**
   * For `"c"`, `main.c` is written to `jobDir` and compiled inside `runner-c:latest` with `${jobDir}:/work:rw` (`gcc /work/main.c -O2 -o /work/main`).
   * If `gcc` exits non-zero, execution is skipped immediately and the worker returns verdict **`CE`** along with compiler `stderr`.
   * For `"python"`, `main.py` is written to `jobDir` with no compilation pass.
3. **Execution pass (`:ro` + Hardened Flags):**
   * Runs `runner-c:latest` (`/work/main`) or `runner-python:latest` (`python3 /work/main.py`) with:
     * `-i` (interactive stdin pipe — added after `AC` and `WA` initially hit `EOFError` / `scanf != 2` when `stdin` was sent to `docker run` without `-i`)
     * `--cpus=0.5`
     * `--network none`
     * `--pids-limit 32`
     * `--memory=128m` and `--memory-swap=128m`
     * `--read-only`
     * `--tmpfs /tmp:rw,noexec,nosuid,size=16m`
     * `-v ${jobDir}:/work:ro` (read-only mount during execution so untrusted code cannot tamper with files in `/work`)

### C. Memory Safety, Stream Cleanup & Output Bounding
* **Bounded stream collectors:** `stdout` and `stderr` are collected through `createBoundedCollector(maxOutputBytes)` so a program flooding gigabytes of output cannot exhaust worker heap memory; excess bytes are discarded and `stdoutTruncated` / `stderrTruncated` flags are recorded.
* **Listener & stream teardown:** `cleanupChildProcess` detaches `data`, `error`, and `close` listeners and destroys child streams (`stdout`, `stderr`, `stdin`) when a run finishes or times out, while handling `stdin` `EPIPE` errors safely.

### D. Disambiguating Exit Code `137` & Deterministic Verdict Mapping
Exit code `137` (`128 + 9` = `SIGKILL`) is ambiguous on its own because both a **timeout `SIGKILL`** and a **kernel memory OOM `SIGKILL`** produce `137` (while CPU throttling via `--cpus=0.5` slows execution rather than directly sending `SIGKILL`).

The worker resolves verdicts in strict priority order:
1. **`TLE` (Time Limit Exceeded):** If the runner's timeout timer expired and killed the process (`timedOut === true`), verdict is `TLE` even if the exit code is `137`.
2. **`MLE` (Memory Limit Exceeded):** If `!timedOut` and `exitCode === 137`, the worker checks container inspection (`detectOomKilled`) via `docker inspect --format '{{.State.OOMKilled}}|{{.HostConfig.Memory}}' <containerName>`. If `OOMKilled` is `true`, verdict is `MLE`.
3. **`AC` / `WA` (Accepted / Wrong Answer):** If `exitCode === 0`, normalized `stdout` (`\r\n` normalized to `\n`, trimmed) is compared against normalized `expectedOutput` -> `AC` if equal, `WA` otherwise.
4. **`RE` (Runtime Error):** Any other non-zero exit code (such as `1` on uncaught Python exceptions like division by zero, crashes, or non-OOM `137`) maps to `RE`.

### E. Guaranteed Cleanup in `finally`
Every `runSubmission` call wraps work in `try ... finally` to run `docker rm -f <containerName>` and `fs.rm(jobDir, { recursive: true, force: true })`, preventing orphaned containers or leftover files on `benchmark-server`.

---

## 4. How `testrunner.js` Was Designed as a Simulated Test Runner

`testrunner.js` acts as a **local simulation harness** for the worker:
* It defines an array of `CASES` covering **`AC`**, **`WA`**, **`CE`**, **`TLE`**, **`MLE`**, and **`RE`** across both C and Python.
* It uses `String.raw` for embedded C/Python snippets so escape sequences like `\n` and `\"` are written accurately into source files rather than altered by JavaScript template escaping.
* In the `MLE` test case, allocating `256 MiB` (`256ULL * 1024ULL * 1024ULL`) with a `volatile` pointer and touching pages every `4096` bytes with an accumulated checksum prevents `gcc -O2` from optimizing away the memory writes and ensures the `128m` container memory cap is genuinely exercised.
* It loops through each case, calls `await runSubmission(job)`, compares `res.verdict` against the expected verdict, prints diagnostic details (`verdict`, `code`, `oom`, `truncOut`, `time`, and `stdout`/`stderr` on failure), and exits non-zero if any case fails.

---

## 5. Summary of Phase 2 Outcome

* `excution_worker.js` and `testrunner.js` run together cleanly as ESM modules via `package.json` (`"type": "module"`).
* All six simulated verdicts (`AC`, `WA`, `CE`, `TLE`, `MLE`, `RE`) pass (`6/6`), verifying the lowest execution and grading layer before adding Redis queuing, database persistence, or a web/API layer.