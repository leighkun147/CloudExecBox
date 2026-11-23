import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

const IMAGES = {
  c: "runner-c:latest",
  python: "runner-python:latest",
};

const HARDENED_RUN_FLAGS = [
  "-i",
  "--cpus=0.5",
  "--network",
  "none",
  "--pids-limit",
  "32",
  "--memory=128m",
  "--memory-swap=128m",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,size=16m",
];

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream

function createBoundedCollector(maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;

  return {
    push(chunk) {
      if (truncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const remaining = maxBytes - totalBytes;

      if (remaining <= 0) {
        truncated = true;
        return;
      }

      if (buf.length <= remaining) {
        chunks.push(buf);
        totalBytes += buf.length;
      } else {
        chunks.push(buf.subarray(0, remaining));
        totalBytes += remaining;
        truncated = true;
      }
    },
    text() {
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

function cleanupChildProcess(child, onStdout, onStderr, onError, onClose, onStdinError) {
  if (child.stdout) {
    child.stdout.removeListener("data", onStdout);
    child.stdout.destroy();
  }
  if (child.stderr) {
    child.stderr.removeListener("data", onStderr);
    child.stderr.destroy();
  }
  if (child.stdin) {
    child.stdin.removeListener("error", onStdinError);
    if (!child.stdin.destroyed) {
      child.stdin.destroy();
    }
  }
  child.removeListener("error", onError);
  child.removeListener("close", onClose);
}

function runCommand(
  cmd,
  args,
  { timeoutMs = 0, stdin = "", maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}
) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false });

    const outCollector = createBoundedCollector(maxOutputBytes);
    const errCollector = createBoundedCollector(maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      cleanupChildProcess(child, onStdout, onStderr, onError, onClose, onStdinError);
      resolve({
        stdout: outCollector.text(),
        stderr: errCollector.text(),
        stdoutTruncated: outCollector.truncated,
        stderrTruncated: errCollector.truncated,
        ...payload,
      });
    };

    const onStdout = (chunk) => {
      outCollector.push(chunk);
    };

    const onStderr = (chunk) => {
      errCollector.push(chunk);
    };

    const onStdinError = () => {
      // Ignore EPIPE/stream errors when child exits or closes stdin early
    };

    const onError = (err) => {
      if (!errCollector.truncated && !errCollector.text()) {
        errCollector.push(err.message);
      }
      finish({
        exitCode: 1,
        timedOut,
      });
    };

    const onClose = (code, signal) => {
      const normalizedCode =
        code !== null ? code : signal === "SIGKILL" ? 137 : 1;
      finish({
        exitCode: normalizedCode,
        timedOut,
      });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);

    if (child.stdin) {
      child.stdin.on("error", onStdinError);
      if (stdin) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    }
  });
}

async function detectOomKilled(containerName) {
  const inspectRes = await runCommand("docker", [
    "inspect",
    "--format",
    "{{.State.OOMKilled}}|{{.HostConfig.Memory}}",
    containerName,
  ]);

  if (inspectRes.exitCode !== 0) {
    return false;
  }

  const [oomFlag] = inspectRes.stdout.trim().split("|");
  return oomFlag === "true";
}

async function forceRemoveContainer(containerName) {
  await runCommand("docker", ["rm", "-f", containerName]);
}

function normalizeOutput(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

export async function runSubmission({
  language,
  sourceCode,
  stdin = "",
  expectedOutput = "",
  timeoutMs = 3000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  baseWorkDir = path.join(os.tmpdir(), "benchmark-jobs"),
}) {
  if (!IMAGES[language]) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const jobId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const containerName = `runner-job-${jobId}`;
  const jobDir = path.join(baseWorkDir, jobId);
  const startTime = performance.now();

  try {
    await fs.mkdir(jobDir, { recursive: true, mode: 0o777 });
    await fs.chmod(jobDir, 0o777);

    if (language === "c") {
      const sourcePath = path.join(jobDir, "main.c");
      await fs.writeFile(sourcePath, sourceCode, { encoding: "utf8", mode: 0o666 });

      const compileRes = await runCommand(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${jobDir}:/work:rw`,
          IMAGES.c,
          "gcc",
          "/work/main.c",
          "-O2",
          "-o",
          "/work/main",
        ],
        {
          timeoutMs: Math.max(timeoutMs, 10000),
          maxOutputBytes,
        }
      );

      if (compileRes.exitCode !== 0) {
        return {
          jobId,
          verdict: "CE",
          exitCode: compileRes.exitCode,
          oomKilled: false,
          stdoutTruncated: compileRes.stdoutTruncated,
          stderrTruncated: compileRes.stderrTruncated,
          elapsedMs: Math.round(performance.now() - startTime),
          stdout: compileRes.stdout,
          stderr: compileRes.stderr,
        };
      }
    } else {
      const scriptPath = path.join(jobDir, "main.py");
      await fs.writeFile(scriptPath, sourceCode, { encoding: "utf8", mode: 0o666 });
    }

    const targetCmd =
      language === "c"
        ? ["/work/main"]
        : ["python3", "/work/main.py"];

    const execArgs = [
      "run",
      "--name",
      containerName,
      ...HARDENED_RUN_FLAGS,
      "-v",
      `${jobDir}:/work:ro`,
      IMAGES[language],
      ...targetCmd,
    ];

    const execRes = await runCommand("docker", execArgs, {
      timeoutMs,
      stdin,
      maxOutputBytes,
    });

    const elapsedMs = Math.round(performance.now() - startTime);
    let oomKilled = false;

    if (!execRes.timedOut && execRes.exitCode === 137) {
      oomKilled = await detectOomKilled(containerName);
    }

    let verdict = "RE";
    if (execRes.timedOut) {
      verdict = "TLE";
    } else if (oomKilled) {
      verdict = "MLE";
    } else if (execRes.exitCode === 0) {
      verdict =
        normalizeOutput(execRes.stdout) === normalizeOutput(expectedOutput)
          ? "AC"
          : "WA";
    }

    return {
      jobId,
      verdict,
      exitCode: execRes.exitCode,
      oomKilled,
      stdoutTruncated: execRes.stdoutTruncated,
      stderrTruncated: execRes.stderrTruncated,
      elapsedMs,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
    };
  } finally {
    await forceRemoveContainer(containerName);
    await fs.rm(jobDir, { recursive: true, force: true });
  }
}
