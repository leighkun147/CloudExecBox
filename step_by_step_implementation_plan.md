# CloudExecBox — Step-by-Step Implementation Plan (KVM $\rightarrow$ Azure)

This document is the chronological engineering playbook for building **CloudExecBox** from Day 1 on a local **Ubuntu KVM virtual server** and deploying the verified system to **Microsoft Azure**.

Each phase is structured as a vertical slice with concrete verification criteria and suggested Git commit milestones to maintain a clean, authentic commit history throughout the semester.

---

## Phase 0: Local Ubuntu KVM Virtual Server Setup

**Goal:** Create a safe, isolated Linux environment on your personal PC that mirrors a real Microsoft Azure VM.

### Tasks
1. **Provision the KVM VM** (Ubuntu 24.04 LTS Server):
   * **vCPU:** 2–4 cores
   * **RAM:** 4 GB
   * **Disk:** 20 GB (`.qcow2`)
   * **Network:** Default NAT (SSH into the VM from your host terminal).
   * *Security Rule:* Do **not** mount shared host folders into the VM while running untrusted code.
2. **Install Core System Dependencies inside the KVM VM:**
   * `git`, `curl`, `nginx`, `build-essential`
   * **Docker Engine** (add your VM user to the `docker` group and verify `docker info` shows `cgroup Version: 2`).
   * **Node.js v20 LTS** + `npm`
   * **Redis** (either `redis-server` via apt or `redis:7-alpine` in Docker bound strictly to `127.0.0.1:6379`).
3. **Take a Clean KVM Snapshot:**
   * Shut down or pause the VM and take a baseline snapshot (`virsh snapshot-create-as <vm-name> clean-base`). If any experiment breaks the guest OS, you can roll back in seconds.

### Verification
* `docker run --rm hello-world` succeeds inside the KVM VM.
* `node -v` outputs `v20.x.x`.
* `redis-cli ping` returns `PONG`.

### Git Milestone
* Initialize the repository on your host or VM, add `README.md`, `IMPLEMENTATION.md`, and `.gitignore`.
* **Commit:** `chore: initialize repository with README and KVM-to-Azure implementation plan`

---

## Phase 1: Sandboxed Runner Images & Manual Exploit Testing

**Goal:** Build the minimal Python and C Docker images and prove that your Docker + `cgroups` flags block all five major attacks before writing any Node.js code.

### Tasks
1. Create `runners/python/Dockerfile`:
   * Base image: `python:3.12-alpine`
   * Run as unprivileged user (`--user 65534:65534`).
   * Set `WORKDIR /code`.
2. Create `runners/c/Dockerfile`:
   * Base image: `alpine:3.20`
   * Install `gcc` and `musl-dev` (`apk add --no-cache gcc musl-dev`).
   * Set `WORKDIR /code`.
3. Build both images on the KVM VM:
   * `docker build -t cloudexec-python:latest ./runners/python`
   * `docker build -t cloudexec-c:latest ./runners/c`
4. **Manual Sandbox Verification (Test every exploit from the KVM shell):**
   * **Normal Python/C script:** Prints expected output and exits with code `0`.
   * **Fork bomb:** `python3 -c "import os; [os.fork() for _ in iter(int, 1)]"` with `--pids-limit="64"` $\rightarrow$ fails immediately with `BlockingIOError` / `Resource temporarily unavailable`.
   * **Memory bomb:** `python3 -c "a = [1] * 10**8"` with `--memory="128m" --memory-swap="128m"` $\rightarrow$ killed with exit code `137` (OOM).
   * **Network/Metadata probe:** `python3 -c "import urllib.request; urllib.request.urlopen('http://169.254.169.254')"` with `--network none` $\rightarrow$ fails immediately with `Network is unreachable`.
   * **Read-only FS probe:** Attempting to write to `/etc/test` or `/code/test` with `--read-only` and `:ro` mount $\rightarrow$ fails with `Read-only file system`.

### Git Milestone
* **Commit:** `feat(runners): add minimal Alpine Dockerfiles for Python and C sandboxes`

---

## Phase 2: Execution Worker & Deterministic Grader

**Goal:** Build the core Node.js execution engine (`worker/executor.js` and `worker/grader.js`) that runs code against test cases inside Docker and returns a deterministic 0–100 score.

### Tasks
1. **Temporary Job Workspace Management:**
   * For each submission, create an isolated temp directory (e.g., `/tmp/cloudexec/<job_id>`), write `main.py` or `main.c`, and guarantee cleanup in a `finally` block.
2. **Hardened Container Spawner (`worker/executor.js`):**
   * Use Node's `child_process.spawn('docker', [...])` (never `exec` with string interpolation, to prevent command injection).
   * Pass the full security flag set: `--rm`, `--network none`, `--cpus="0.5"`, `--memory="128m"`, `--memory-swap="128m"`, `--pids-limit="64"`, `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid,size=16m`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--user 65534:65534`, `--log-driver=none`.
   * Pipe each test case's `stdin` directly into the container's standard input stream.
   * **Wall-Clock Timeout (`TLE`):** Start a timer (e.g., `2000 ms`). If the container is still running, execute `docker kill <container_name>` and mark verdict `TLE`.
   * **Output Cap (`OLE`):** Accumulate `stdout` chunks up to `65536` bytes (`64 KB`). If exceeded, kill the container immediately and mark verdict `OLE`.
   * **C Compilation Step (`CE`):** For C submissions, run a separate compile container (`gcc /code/main.c -O2 -o /tmp/app`) with a `5000 ms` timeout first; if compilation fails, return `CE` with `stderr` and skip test cases.
3. **Deterministic Grader (`worker/grader.js`):**
   * Normalize line endings (`\r\n` $\rightarrow$ `\n`) and trim trailing whitespace before comparing `stdout` to `expected_stdout`.
   * Record per-test-case verdict (`AC`, `WA`, `TLE`, `MLE`, `OLE`, `RE`, `CE`) and wall-clock time in milliseconds.
   * Calculate final score: $\text{Score} = \text{round}\left(\frac{\text{passed}}{\text{total}} \times 100\right)$.

### Verification
* Run a standalone CLI test script against `grader.js` with a sample problem (e.g., *Sum of Two Numbers*) testing valid Python, valid C, wrong answer, syntax/compile error, and infinite loop.

### Git Milestone
* **Commit:** `feat(worker): implement hardened Docker executor with TLE/MLE/OLE guards`
* **Commit:** `feat(grader): add deterministic test-case comparison and 0-100 scoring logic`

---

## Phase 3: SQLite Database, Message Queue & REST API

**Goal:** Decouple HTTP submission intake from container execution using Redis + BullMQ and persist state in SQLite.

### Tasks
1. **Database (`api/db.js`):**
   * Create SQLite tables:
     * `problems` (`id`, `title`, `description`, `starter_python`, `starter_c`, `time_limit_ms`, `memory_limit_mb`)
     * `test_cases` (`id`, `problem_id`, `input`, `expected_output`, `is_sample`)
     * `submissions` (`id`, `problem_id`, `language`, `code`, `status`, `score`, `verdict`, `runtime_ms`, `results_json`, `created_at`)
   * Seed 3–5 clear algorithmic problems (e.g., *Two Sum*, *Fibonacci*, *Palindrome Check*, *Array Max*) with 5–10 test cases each.
2. **Queue (`api/queue.js` & `worker/worker.js`):**
   * Configure a BullMQ queue (`code-submissions`) backed by local Redis.
   * Set worker concurrency to `2` (safe for a 2–4 vCPU VM) so simultaneous submissions queue cleanly without overloading RAM.
3. **REST API (`api/server.js`):**
   * `GET /api/problems` — Lists available problems.
   * `GET /api/problems/:id` — Returns problem details and sample test cases.
   * `POST /api/submit` — Validates `language` (`python` | `c`), `problem_id`, and `code` size cap (e.g., max `32 KB`); inserts `QUEUED` row in SQLite; enqueues job in BullMQ; returns `202 Accepted` with `{ submissionId }`.
   * `GET /api/submissions/:id` — Returns current status (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`), final score, overall verdict, runtime, and per-test-case breakdown.

### Verification
* Send 10 concurrent `POST /api/submit` requests using `curl` or a small Node script. Confirm all 10 immediately receive `202 Accepted`, the worker processes them 2 at a time, and all 10 transition cleanly to `COMPLETED`.

### Git Milestone
* **Commit:** `feat(db): add SQLite schema and seed algorithmic problems with test cases`
* **Commit:** `feat(api): add Express REST API and BullMQ asynchronous job queue`

---

## Phase 4: Web Frontend & Nginx Reverse Proxy

**Goal:** Build a clean, responsive developer UI and serve the entire application behind Nginx on port 80 inside the KVM VM.

### Tasks
1. **Web Interface (`frontend/`):**
   * `index.html`: Split-pane layout—problem description & sample I/O on the left; language selector (`Python 3` / `C`), CodeMirror code editor, and **Submit** button on the right; results panel at the bottom.
   * `app.js`:
     * Loads problems from `GET /api/problems`.
     * Submits code via `POST /api/submit`.
     * Displays `Queued...` / `Running...` state while polling `GET /api/submissions/:id` every `500 ms`.
     * Renders the final **Score (0–100)**, total runtime, and color-coded per-test-case verdict badges (`AC`, `WA`, `TLE`, `MLE`, `OLE`, `RE`, `CE`).
2. **Nginx Configuration (`deploy/nginx.conf`):**
   * Serve `/frontend` at `/`.
   * Proxy `/api/` to `http://127.0.0.1:3000`.
   * Enforce a request body limit (`client_max_body_size 64k;`).

### Verification
* Open the KVM VM's IP address in your host PC's web browser.
* Submit both Python and C solutions through the UI and verify live polling, scoring, and error display.

### Git Milestone
* **Commit:** `feat(frontend): build HTML/JS code editor UI with live submission polling`
* **Commit:** `chore(deploy): add Nginx reverse proxy configuration`

---

## Phase 5: Automated Security & Load Test Suite

**Goal:** Prove—with repeatable scripts and logged outputs—that your platform defends against malicious code and handles concurrent load.

### Tasks
1. Write `tests/security-tests.js` that submits the following payloads through your live `POST /api/submit` endpoint and asserts the expected verdicts:
   * Valid Python & C solutions $\rightarrow$ `AC` (`100/100`)
   * Infinite loop (`while True: pass` & `while(1){}`) $\rightarrow$ `TLE` (`0/100`)
   * Fork bomb (Python & C) $\rightarrow$ `RE` / blocked without host freeze
   * Memory bomb (allocating >128 MB) $\rightarrow$ `MLE` (`0/100`)
   * Infinite `printf` flood $\rightarrow$ `OLE` (`0/100`), host disk unaffected
   * Cloud metadata SSRF (`http://169.254.169.254/latest/meta-data/`) $\rightarrow$ `RE` (`Network is unreachable`)
   * Read-only filesystem write attempt $\rightarrow$ `RE` (`Read-only file system`)
2. Run a small concurrency test (e.g., 15 simultaneous submissions) and record queue wait time, execution time, and VM CPU/RAM usage via `htop` / `docker stats`.
3. Save clean terminal logs and screenshots for the project report.

### Git Milestone
* **Commit:** `test(security): add automated exploit and concurrency verification suite`

---

## Phase 6: Stage 2 — Deployment to Microsoft Azure & Final Deliverables

**Goal:** Migrate the proven KVM setup onto Microsoft Azure, document cloud architecture/costs, and record the final demo.

### Tasks
1. **Azure Account & Budget Guardrails:**
   * Log in to **Azure for Students** and create a dedicated Resource Group (e.g., `rg-cloudexecbox`).
   * **Immediately configure an Azure Budget Alert** (e.g., notify at USD 10, USD 20) to prevent surprise charges.
2. **Provision Azure Linux VM:**
   * Create an **Ubuntu 24.04 LTS** VM (e.g., `Standard_B2s` — 2 vCPU, 4 GB RAM, matching your KVM VM).
   * Configure **Network Security Group (NSG)** inbound rules:
     * Allow `TCP 22` (SSH — restricted to your IP if possible).
     * Allow `TCP 80` / `TCP 443` (HTTP/HTTPS for Nginx).
     * **Block** Redis (`6379`) and Node.js (`3000`) from the public internet.
3. **Deploy the Exact Same Stack:**
   * SSH into the Azure VM, install Docker, Node.js v20, Redis, and Nginx.
   * Clone your GitHub repository, build the `cloudexec-python` and `cloudexec-c` images, configure Nginx, and run the API + Worker under `pm2` or `systemd` so they stay running cleanly.
   * *(Optional)* Point a Cloudflare domain/Cloudflare Tunnel to your Azure VM for free HTTPS.
4. **Run Final Verification on Azure:**
   * Re-run `tests/security-tests.js` against your Azure VM's live URL—especially verifying that the `169.254.169.254` Azure IMDS probe is blocked by `--network none`.
5. **Finalize Report & Demo:**
   * Capture Azure Portal screenshots (VM overview, NSG rules, Resource Group, Cost Management spending summary).
   * Add your architecture diagram (`docs/architecture.png`), security test results, cost analysis, and AI usage statement into `README.md` (and export the 5–10 page PDF report).
   * Record the **8–10 minute narrated demo video** covering: architecture, live web app (Python & C), malicious code protection tests, code walkthrough, and the Azure Portal resources.
   * **Post-Grading Cleanup:** Delete the `rg-cloudexecbox` Resource Group in Azure once grading is complete.

### Git Milestone
* **Commit:** `docs(report): embed architecture diagram, Azure deployment details, security benchmarks, and cost analysis`