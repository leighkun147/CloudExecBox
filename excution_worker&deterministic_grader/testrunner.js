import { runSubmission } from "./excution_worker.js";

const CASES = [
  {
    name: "AC (C sum)",
    job: {
      language: "c",
      sourceCode: String.raw`
#include <stdio.h>

int main(void) {
    int a, b;
    if (scanf("%d %d", &a, &b) != 2) return 1;
    printf("%d\n", a + b);
    return 0;
}
`,
      stdin: "7 5\n",
      expectedOutput: "12",
      timeoutMs: 3000,
    },
  },
  {
    name: "WA (Python wrong sum)",
    job: {
      language: "python",
      sourceCode: String.raw`
a, b = map(int, input().split())
print(a * b)
`,
      stdin: "7 5\n",
      expectedOutput: "12",
      timeoutMs: 3000,
    },
  },
  {
    name: "CE (C syntax error)",
    job: {
      language: "c",
      sourceCode: String.raw`
#include <stdio.h>

int main(void) {
    printf("missing semicolon")
    return 0;
}
`,
      stdin: "",
      expectedOutput: "missing semicolon",
      timeoutMs: 3000,
    },
  },
  {
    name: "TLE (Python infinite loop)",
    job: {
      language: "python",
      sourceCode: String.raw`
print("looping", flush=True)
while True:
    pass
`,
      stdin: "",
      expectedOutput: "looping",
      timeoutMs: 2000,
    },
  },
  {
    name: "MLE (C 256MB over 128m cap)",
    job: {
      language: "c",
      sourceCode: String.raw`
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    size_t bytes = 256ULL * 1024ULL * 1024ULL;
    volatile unsigned char *p = malloc(bytes);
    if (!p) {
        fprintf(stderr, "malloc returned NULL\n");
        return 1;
    }
    volatile unsigned long long sum = 0;
    for (size_t i = 0; i < bytes; i += 4096) {
        p[i] = (unsigned char)(i & 0xff);
        sum += p[i];
    }
    printf("%llu\n", sum);
    return 0;
}
`,
      stdin: "",
      expectedOutput: "",
      timeoutMs: 4000,
    },
  },
  {
    name: "RE (Python division by zero)",
    job: {
      language: "python",
      sourceCode: String.raw`
x = 1 / 0
print(x)
`,
      stdin: "",
      expectedOutput: "",
      timeoutMs: 3000,
    },
  },
];

async function main() {
  let passed = 0;

  for (const { name, job } of CASES) {
    const expectedVerdict = name.split(" ")[0];
    const res = await runSubmission(job);
    const ok = res.verdict === expectedVerdict;
    if (ok) passed++;

    console.log(
      `[${ok ? "PASS" : "FAIL"}] ${name} -> verdict=${res.verdict} (expected ${expectedVerdict}), code=${res.exitCode}, oom=${Boolean(res.oomKilled)}, truncOut=${Boolean(res.stdoutTruncated)}, time=${res.elapsedMs}ms`
    );
    if (!ok) {
      console.log("  stdout:", JSON.stringify(res.stdout));
      console.log("  stderr:", JSON.stringify(res.stderr));
    }
  }

  console.log(`\nSummary: ${passed}/${CASES.length} passed`);
  if (passed !== CASES.length) {
    process.exitCode = 1;
  }
}

main();
