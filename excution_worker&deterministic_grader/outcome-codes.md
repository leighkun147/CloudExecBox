| Code | Full Name | Type | What It Means in Practice |
| :--- | :--- | :--- | :--- |
| **AC** | **Accepted** | Pass | Your code compiled (if C), finished within time and memory limits, exited with `0`, and its output matched the expected output. |
| **WA** | **Wrong Answer** | Grading fail | Your code ran to completion (`exitCode === 0`) within limits, but produced the wrong output for at least one test case. |
| **CE** | **Compilation Error** | Build error | For compiled languages like C, `gcc` rejected the code (syntax error, missing header, undefined symbol) before execution ever started. |
| **TLE** | **Time Limit Exceeded** | Execution limit | Your code took longer than `timeoutMs` (for example, an infinite loop or an algorithm with too high time complexity) and was stopped. |
| **MLE** | **Memory Limit Exceeded** | Execution limit | Your code tried to use more memory than allowed (for example, allocating `256 MB` over your `128m` container cap) and was killed by the OOM killer. |
| **RE** | **Runtime Error** | Execution crash | Your code started running and crashed or exited non-zero mid-execution—such as division by zero, `EOFError` on `input()`, `scanf` failing, segfault, or blocked system/network/fork calls. |

### Key Distinction: `WA` vs. Errors (`CE`, `TLE`, `MLE`, `RE`)

* **`WA`** means your logic/edge-case handling missed the expected answer, even though the program executed normally.
* **`CE`, `TLE`, `MLE`, and `RE`** mean something went wrong in building or running the program itself—such as a syntax mistake, infinite loop, memory blowup, or unhandled exception/crash.