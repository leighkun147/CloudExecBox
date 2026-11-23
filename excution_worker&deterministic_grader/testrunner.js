import { gradeSubmission } from "./grader.js";

const ALGORITHM_TEST_CASES = [
  {
    name: "Small positive numbers",
    points: 20,
    stdin: "5\n3 9 1 7 4\n",
    expectedOutput: "9",
    timeoutMs: 3000,
  },
  {
    name: "Single element",
    points: 20,
    stdin: "1\n42\n",
    expectedOutput: "42",
    timeoutMs: 3000,
  },
  {
    name: "All negative numbers",
    points: 20,
    stdin: "4\n-15 -3 -99 -1\n",
    expectedOutput: "-1",
    timeoutMs: 3000,
  },
  {
    name: "Zeros and duplicates",
    points: 20,
    stdin: "6\n0 0 8 8 2 0\n",
    expectedOutput: "8",
    timeoutMs: 3000,
  },
  {
    name: "Large values near 32-bit int",
    points: 20,
    stdin: "3\n1000000000 2000000000 1500000000\n",
    expectedOutput: "2000000000",
    timeoutMs: 3000,
  },
];

const SUBMISSIONS = [
  {
    label: "Optimal C solution (expected AC, 100/100)",
    expectedVerdict: "AC",
    expectedScore: 100,
    submission: {
      language: "c",
      sourceCode: String.raw`
#include <stdio.h>

int main(void) {
    int n;
    if (scanf("%d", &n) != 1 || n <= 0) return 1;

    long long best;
    if (scanf("%lld", &best) != 1) return 1;

    for (int i = 1; i < n; i++) {
        long long x;
        if (scanf("%lld", &x) != 1) return 1;
        if (x > best) best = x;
    }

    printf("%lld\n", best);
    return 0;
}
`,
      testCases: ALGORITHM_TEST_CASES,
    },
  },
  {
    label: "Buggy Python solution initialized to 0 (expected WA, 80/100)",
    expectedVerdict: "WA",
    expectedScore: 80,
    submission: {
      language: "python",
      sourceCode: String.raw`
n = int(input().strip())
nums = list(map(int, input().split()))
best = 0
for x in nums:
    if x > best:
        best = x
print(best)
`,
      testCases: ALGORITHM_TEST_CASES,
    },
  },
  {
    label: "Syntax error C solution (expected CE, 0/100)",
    expectedVerdict: "CE",
    expectedScore: 0,
    submission: {
      language: "c",
      sourceCode: String.raw`
#include <stdio.h>

int main(void) {
    printf("broken")
    return 0;
}
`,
      testCases: ALGORITHM_TEST_CASES,
    },
  },
  {
    label: "Crashing Python solution on input (expected RE, 0/100)",
    expectedVerdict: "RE",
    expectedScore: 0,
    submission: {
      language: "python",
      sourceCode: String.raw`
n = int(input().strip())
raise RuntimeError("simulated runtime failure")
`,
      testCases: ALGORITHM_TEST_CASES,
    },
  },
];

async function main() {
  let passedSuites = 0;

  for (const item of SUBMISSIONS) {
    const report = await gradeSubmission(item.submission);
    const ok =
      report.verdict === item.expectedVerdict &&
      report.score === item.expectedScore;

    if (ok) passedSuites++;

    console.log(
      `[${ok ? "PASS" : "FAIL"}] ${item.label} -> verdict=${report.verdict}, score=${report.score}/${report.maxScore}, passed=${report.passedCount}/${report.totalCases}, time=${report.elapsedMs}ms`
    );

    for (const c of report.cases) {
      console.log(
        `   - Case ${c.index + 1} (${c.name}): ${c.verdict} (${c.pointsEarned}/${c.maxPoints} pts, ${c.elapsedMs}ms)`
      );
    }

    if (!ok) {
      console.log(
        `   Expected verdict=${item.expectedVerdict}, score=${item.expectedScore}`
      );
      if (report.compileStderr) {
        console.log("   compileStderr:", JSON.stringify(report.compileStderr));
      }
    }
  }

  console.log(`\nSuites passed: ${passedSuites}/${SUBMISSIONS.length}`);
  if (passedSuites !== SUBMISSIONS.length) {
    process.exitCode = 1;
  }
}

main();