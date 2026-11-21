# CloudExecBox — Cloud-Based Online Code Execution Platform

**CloudExecBox** is a cloud-based online code execution platform (mini online judge) designed to safely compile, execute, and grade untrusted source code in isolated Docker containers. It enforces strict Linux `cgroups` resource limits, asynchronous job queuing, and deterministic test-case grading without relying on AI or machine learning models.

---

## 1. Project Goal

The objective of this project is to engineer a secure, scalable, and reproducible remote code execution (RCE) system that supports multiple programming languages (starting with **Python 3** and **C**). The platform is designed to:

1. Accept user-submitted source code through a lightweight web interface.
2. Decouple request intake from code execution using an asynchronous message queue so traffic spikes never crash the server.
3. Execute untrusted code inside ephemeral, hardened Docker containers with strict CPU, memory, process, filesystem, and network isolation.
4. Grade submissions deterministically by comparing captured `stdout` against predefined test cases and measuring execution time and resource usage to return a score out of 100.
5. Demonstrate full parity between a local **Ubuntu KVM virtual server** (development & security testing) and a **Microsoft Azure Linux VM** (production cloud deployment).

---

## 2. System Architecture

~~~text
+-------------------------------------------------------+
|   Web Browser (HTML5 / CSS3 / Vanilla JS + CodeMirror)|
+---------------------------+---------------------------+
                            |
                            | 1. POST /api/submit (202 Accepted)
                            | 6. GET  /api/submissions/:id (Polling)
                            v
+-------------------------------------------------------+
|         Nginx Reverse Proxy & Static File Server      |
+---------------------------+---------------------------+
                            |
                            v
+-------------------------------------------------------+
|          REST API Server (Node.js + Express)          |
+-------------+---------------------------+-------------+
              |                           ^
              | 2. Enqueue Job            | 5. Read Status, Score & Metrics
              v                           |
+---------------------------+   +---------+-------------+
| Message Queue (Redis +    |   | SQLite Database       |
| BullMQ)                   |   | (Problems, Test Cases,|
+-------------+-------------+   |  Submissions)         |
              |                 +---------^-------------+
              | 3. Pull Job               |
              | (Bounded Concurrency)     | 4b. Save Verdict & Metrics
              v                           |
+-----------------------------------------+-------------+
|            Execution Worker Service (Node.js)         |
+---------------------------+---------------------------+
                            |
                            | 4a. Spawn Ephemeral Container
                            |     (--network none, cgroups, read-only)
                            v
+-------------------------------------------------------+
|   Docker Engine (Minimal Python & C Runner Images)    |
+-------------------------------------------------------+
~~~

### Request Lifecycle
1. **Submission:** The user selects a problem, writes Python or C code in the browser editor, and clicks **Submit**.
2. **Async Intake:** The Express API validates the payload, stores a `QUEUED` record in SQLite, pushes the job to **Redis/BullMQ**, and immediately returns `HTTP 202 Accepted` with a `submission_id`.
3. **Polling:** The frontend polls `GET /api/submissions/:id` every `500 ms` until execution finishes.
4. **Sandboxed Execution:** The Worker pulls the job, writes the code to a temporary job directory, and spawns an isolated Docker container for each test case (with a separate restricted compilation step for C).
5. **Deterministic Grading:** The Worker captures `stdout`, `stderr`, exit code, and wall-clock execution time, compares outputs against expected results, calculates the score (0–100), cleans up all temporary files, and updates SQLite.

---

## 3. Technology Stack

Every component is chosen for **1-to-1 parity** between the local Ubuntu KVM virtual machine and the Microsoft Azure Ubuntu VM:

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | HTML5, CSS3, Vanilla JS, CodeMirror (CDN) | Zero-build-bloat web editor with syntax highlighting and live verdict display. |
| **Web Server / Proxy** | Nginx | Serves static frontend files and reverse-proxies `/api/*` requests to Node.js. |
| **Backend API** | Node.js (v20 LTS) + Express | Handles problem listings, submission intake, and status polling. |
| **Message Queue** | Redis + BullMQ | Buffers incoming execution jobs and enforces bounded worker concurrency. |
| **Database** | SQLite (`better-sqlite3`) | Lightweight, zero-daemon relational store for problems, test cases, and submission history. |
| **Sandbox Engine** | Docker Engine + Linux `cgroups` | Isolates untrusted code execution with strict kernel-level resource caps. |
| **Runner Images** | Custom Alpine Linux (`python:3.12-alpine`, `gcc`) | Minimal attack surface and fast container startup times. |
| **Stage 1 Host (Dev)** | Local Ubuntu 24.04 LTS KVM Virtual Machine | Hardware-virtualized sandbox for safe local development and exploit testing. |
| **Stage 2 Host (Cloud)** | Microsoft Azure Linux VM (Ubuntu 24.04 LTS) | Cloud deployment with NSG firewall rules, budget alerts, and optional HTTPS via Cloudflare Tunnel / Certbot. |

---

## 4. Deterministic Grading & Scoring

No AI or machine learning models are used for evaluation. Grading is 100% deterministic:

* Each problem defines a set of hidden and visible `(stdin, expected_stdout)` test cases.
* Each test case produces one of the following verdicts:
  * `AC` (**Accepted**): Exit code `0`, within time/memory/output limits, trimmed `stdout` matches `expected_stdout`.
  * `WA` (**Wrong Answer**): Exited cleanly, but `stdout` does not match `expected_stdout`.
  * `TLE` (**Time Limit Exceeded**): Exceeded the worker-enforced wall-clock timeout and was terminated via `docker kill`.
  * `MLE` (**Memory Limit Exceeded**): Terminated by the Linux `cgroups` OOM killer (exit code `137`).
  * `OLE` (**Output Limit Exceeded**): Exceeded the maximum allowed `stdout` byte stream cap.
  * `RE` (**Runtime Error**): Non-zero exit code (e.g., segmentation fault, division by zero).
  * `CE` (**Compilation Error**): `gcc` failed to compile the C source file.

The final submission score out of 100 is computed as:

$$\text{Score} = \left(\frac{\text{Passed Test Cases}}{\text{Total Test Cases}}\right) \times 100$$

---

## 5. Security & Sandbox Hardening

Untrusted code is never executed on the host OS. Every runner container is launched with defense-in-depth flags to neutralize system-level exploits:

| Threat / Attack Vector | Impact Without Protection | Mitigation Implemented |
| :--- | :--- | :--- |
| **Infinite Loop** (`while(1){}`) | Permanently hangs a worker slot and pegs CPU. | `--cpus="0.5"` + external worker wall-clock timeout (`docker kill` $\rightarrow$ `TLE`). |
| **Fork Bomb** (`while(1) fork();`) | Exhausts the shared host kernel's global PID table and freezes the VM. | `--pids-limit="64"` (Linux `pids` cgroup blocks process creation immediately). |
| **Memory Bomb** (`a = [1] * 10**9`) | Triggers host OOM killer and crashes the API/Redis. | `--memory="128m" --memory-swap="128m"` (hard RAM cap, swap disabled $\rightarrow$ `MLE`). |
| **Infinite `printf` / Disk Exhaustion** | Fills host disk via Docker JSON logs or crashes Worker RAM. | `--log-driver=none`, `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid,size=16m`, and worker-side `stdout` byte cap (`64 KB` $\rightarrow$ `OLE`). |
| **Cloud Metadata / SSRF** (`169.254.169.254`) | Steals cloud VM IAM credentials or scans internal Redis ports. | `--network none` (strips all network interfaces except loopback). |
| **Privilege Escalation** | Escaping container permissions or modifying mounted files. | `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--user 65534:65534`, read-only code bind mount (`:ro`). |

---

## 6. Repository Structure

~~~text
cloudexecbox/
├── README.md                 # Project documentation & final report
├── IMPLEMENTATION.md         # Step-by-step KVM -> Azure build guide
├── docs/
│   ├── architecture.png      # System architecture diagram
│   └── screenshots/          # Azure console, security tests, and cost screenshots
├── runners/
│   ├── python/
│   │   └── Dockerfile        # Minimal Python 3 runner image
│   └── c/
│       └── Dockerfile        # Minimal GCC C runner image
├── api/
│   ├── server.js             # Express REST API (submit, status, problems)
│   ├── db.js                 # SQLite schema & seed data
│   └── queue.js              # BullMQ producer configuration
├── worker/
│   ├── worker.js             # BullMQ consumer
│   ├── executor.js           # Hardened Docker execution & timeout/OLE controller
│   └── grader.js             # Deterministic output comparison & 0-100 scoring
├── frontend/
│   ├── index.html            # Web UI layout
│   ├── styles.css            # Styling
│   └── app.js                # CodeMirror setup, submit & polling logic
├── tests/
│   └── security-tests.js     # Automated exploit test suite (fork bomb, TLE, MLE, OLE, SSRF)
├── deploy/
│   └── nginx.conf            # Nginx reverse proxy configuration
├── package.json
└── .gitignore
~~~

---

## 7. Quick Start (Ubuntu KVM / Azure VM)

~~~bash
# 1. Clone the repository
git clone https://github.com/leighkun147/CloudExecBox.git
cd CloudExecBox

# 2. Install Node.js dependencies
npm install

# 3. Build the sandboxed runner images
docker build -t cloudexec-python:latest ./runners/python
docker build -t cloudexec-c:latest ./runners/c

# 4. Start Redis (via Docker or local systemd service)
docker run -d --name cloudexec-redis -p 127.0.0.1:6379:6379 redis:7-alpine

# 5. Start the API server and Execution Worker
node api/server.js
node worker/worker.js
~~~

---

## 8. Deliverables & Evaluation Sections *(To Be Completed During Phases 5–6)*

* **Security Test Results:** Output logs proving clean containment of infinite loops, fork bombs, memory bombs, `printf` floods, and `169.254.169.254` SSRF probes.
* **Azure Cloud Deployment & Cost Analysis:** Azure VM specifications, NSG rules, budget alert configuration, and actual spending summary.
* **Demo Video (8–10 min):** *(Link to be added upon completion)*
* **AI Usage Statement:** *(To be filled out at project submission per course guidelines)*