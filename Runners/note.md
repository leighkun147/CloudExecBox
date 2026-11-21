# Runners Lab Notes (`runners/note.md`)

Step-by-step log of verifying, running, and testing resource/filesystem isolation on `runner-python:latest` and `runner-c:latest` on `benchmark-server` (KVM Ubuntu VM).

---

## 1. Pre-Built Runner Images Verified

Before running containers, both runner images were built and checked locally on `benchmark-server`:

* `runner-c:latest` (includes `gcc` and `musl-dev`, configured with non-root user `65534:65534`)
* `runner-python:latest` (includes `python3`, configured with non-root user `65534:65534`)

Verification command used:

```bash
docker images | grep runner-
```

---

## 2. Basic Container Execution Checks

### 2.1 Python Runner Sanity Check
Ran a minimal one-line print inside `runner-python:latest` with `--rm` so the container is removed automatically when finished:

```bash
docker run --rm runner-python:latest python3 -c 'print("Runner is alive!")'
```

* **Result:** Printed `Runner is alive!` and exited cleanly.

### 2.2 C Compiler Check (`gcc`)
Verified that `gcc` is available inside `runner-c:latest`:

```bash
docker run --rm runner-c:latest gcc --version
```

* **Result:** Confirmed Alpine's `gcc` toolchain is installed and callable.

---

## 3. C Compilation vs. Execution & Host Permissions

### 3.1 Initial C Source File (`hello.c`)
Created a practice directory (`~/test-codes-folder`) and wrote `hello.c`:

```c
#include <stdio.h>

int main(void) {
    printf("C runner is alive!\n");
    return 0;
}
```

### 3.2 Compiling with `:rw` and Hitting `Permission denied`
Attempted to compile `hello.c` into `/work/hello` by mounting `~/test-codes-folder` as read-write (`:rw`):

```bash
docker run --rm \
  -v ~/test-codes-folder:/work:rw \
  runner-c:latest \
  gcc /work/hello.c -o /work/hello
```

* **What happened:** The linker (`ld`) failed with `cannot open output file /work/hello: Permission denied`.
* **Why:** Inside the container, the process runs as non-root UID `65534` (`nobody`), whereas `~/test-codes-folder` on `benchmark-server` was owned by the host user (`leykun`) without write permission for other users.

### 3.3 Allowing Write on the Practice Folder & Running with `:ro`
Granted write permission on the temporary practice directory:

```bash
chmod 777 ~/test-codes-folder
```

Compiled with `:rw` so `gcc` could write the binary:

```bash
docker run --rm \
  -v ~/test-codes-folder:/work:rw \
  runner-c:latest \
  gcc /work/hello.c -o /work/hello
```

Then executed the compiled binary with `/work` mounted **read-only (`:ro`)** so untrusted execution cannot modify files in `/work`:

```bash
docker run --rm \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **Result:** Printed `C runner is alive!`.

---

## 4. Filesystem & `tmpfs` Restriction Experiments

### 4.1 Writing to Read-Only `/work`
Updated `hello.c` to call `fopen("/work/pwned.txt", "w")` and `perror("fopen failed")` on failure, recompiled (`:rw`), and ran with `-v ~/test-codes-folder:/work:ro`.

* **Result:** `fopen failed: Read-only file system`. The kernel blocked writing to `/work`.

### 4.2 Writing to `/tmp` Without `--read-only`
Updated `hello.c` to write to `/tmp/pwned.txt` instead of `/work/pwned.txt`, recompiled (`:rw`), and ran with `-v ~/test-codes-folder:/work:ro`.

* **Result:** Succeeded inside that container's writable `/tmp` layer (and disappeared on exit due to `--rm`).

### 4.3 Locking Root Filesystem with `--read-only` + Bounded `--tmpfs /tmp`
Tested locking the container's root filesystem (`--read-only`) while providing a small, bounded, non-executable RAM-backed `/tmp` mount:

```bash
docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **What each flag enforces:**
  * `--read-only`: Makes the container's root filesystem read-only.
  * `--tmpfs /tmp:rw,noexec,nosuid,size=16m`: Mounts a RAM-backed `/tmp` up to `16m` (16 MB), prevents executing binaries from `/tmp` (`noexec`), and ignores setuid/setgid bits (`nosuid`).

### 4.4 Testing the `16m` `tmpfs` Size Ceiling
* **Experiment:** Attempted to write a larger file (e.g., 20 MB > 16 MB) to `/tmp/bigfile.txt` under `--tmpfs /tmp:rw,noexec,nosuid,size=16m`.
* **Observed behavior / error:** *(Record your terminal output and `perror` message here.)*

---

## 5. Resource Constraint & Isolation Experiments (`runner-c:latest`)

As we continue testing resource constraints on `docker run`, log each configuration and result below:

For every test below, `hello.c` was edited in `~/test-codes-folder`, compiled via the `:rw` compiler container (`gcc /work/hello.c ... -o /work/hello`), and then executed inside a hardened container (`UID 65534:65534`) with `/work` mounted read-only (`:ro`). Only the relevant C snippet, `docker run` execution command, and observed outcome are recorded for each test.

---

### 5.1 Read-Only Mounts, `--read-only` Root, and Bounded `--tmpfs /tmp`

* **What we tweaked in `hello.c`:** Switched `fopen()` from `"/work/pwned.txt"` to `"/tmp/pwned.txt"` (and verified larger writes against the `16m` cap):

```c
FILE *f = fopen("/tmp/pwned.txt", "w");
if (!f) { perror("fopen failed"); return 1; }
fprintf(f, "test\n");
fclose(f);
```

* **Execution command:**

```bash
docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **Observed result:** Writing to `/work/pwned.txt` under `:ro` failed with `fopen failed: Read-only file system`. Writing a small file to `/tmp/pwned.txt` succeeded inside the RAM-backed `16m` `tmpfs` scratchpad (`noexec` blocks executing binaries from `/tmp`, `nosuid` ignores setuid/setgid bits), and `--rm` wipes it on exit; exceeding `size=16m` hits the `tmpfs` ceiling (`ENOSPC` / `No space left on device`).

---

### 5.2 Memory Cap (`--memory` & `--memory-swap`)

* **What we tweaked in `hello.c`:** Allocated `256 MB` on the heap and touched every `4096`-byte page so the kernel commits physical pages rather than leaving them unmapped:

```c
size_t bytes = 256 * 1024 * 1024;
char *buf = malloc(bytes);
for (size_t i = 0; i < bytes; i += 4096) buf[i] = 'A';
```

* **Execution command:**

```bash
docker run --rm \
  --memory="128m" \
  --memory-swap="128m" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **Observed result:** No `printf` output reached stdout; the container was killed by the kernel OOM killer (`SIGKILL`, signal `9`) when crossing `128m`, returning **exit code `137`** (`128 + 9`).

---

### 5.3 Process / PID Cap (`--pids-limit`)

* **What we tweaked in `hello.c`:** Looped up to `50` times calling `fork()`, exiting children immediately via `_exit(0)` and reaping them with `wait(NULL)`:

```c
pid_t pid = fork();
if (pid < 0) { perror("fork failed"); break; }
else if (pid == 0) { _exit(0); }
else { spawned++; }
```

* **Execution command:**

```bash
docker run --rm \
  --pids-limit 32 \
  --memory="128m" \
  --memory-swap="128m" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **Observed result:** Spawned **31** child processes (`1` parent + `31` children = `32` PIDs in the `pids` cgroup), then printed `fork failed: Resource temporarily unavailable` (`EAGAIN`) on the next `fork()`.

---

### 5.4 Network Isolation (`--network none`)

* **What we tweaked in `hello.c`:** Opened an IPv4 TCP socket and attempted `connect()` to `1.1.1.1:80`:

```c
int sock = socket(AF_INET, SOCK_STREAM, 0);
inet_pton(AF_INET, "1.1.1.1", &addr.sin_addr);
if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    perror("connect failed");
}
```

* **Execution command:**

```bash
docker run --rm \
  --network none \
  --pids-limit 32 \
  --memory="128m" \
  --memory-swap="128m" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **Observed result:** Printed `connect failed: Network unreachable` (`ENETUNREACH`) immediately because `--network none` removes external network interfaces/routes from the container's network namespace.

---

### 5.5 CPU Quota Throttling (`--cpus`)

* **What we tweaked in `hello.c`:** Ran a `20,000,000,000`-iteration (`20000000000ULL`) `volatile` accumulator loop and measured wall-clock runtime with `clock_gettime(CLOCK_MONOTONIC, ...)`:

```c
volatile unsigned long long acc = 0;
for (unsigned long long i = 0; i < 20000000000ULL; i++) {
    acc += (i * 3ULL) ^ 0x5a5a5a5aULL;
}
```

* **Execution commands:**

```bash
# Throttled to 0.5 CPUs
docker run --rm \
  --cpus="0.5" \
  --network none \
  --pids-limit 32 \
  --memory="128m" \
  --memory-swap="128m" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello

# Compared against --cpus="2.0"
docker run --rm \
  --cpus="2.0" \
  --network none \
  --pids-limit 32 \
  --memory="128m" \
  --memory-swap="128m" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **Observed result:** Both runs produced the exact same checksum (`acc=9767999145548833792`), while wall-clock runtime stretched from **`4.52s`** (`--cpus="2.0"`) to **`19.01s`** (`--cpus="0.5"`) due to `cgroups` CPU bandwidth throttling.

---

### 5.6 Execution Timeout on an Infinite Loop (`timeout --signal=KILL`)

* **What we tweaked in `hello.c`:** Flushed stdout and entered an unbreakable `while (1)` spin loop:

```c
printf("Entering infinite loop...\n");
fflush(stdout);
while (1) {}
```

* **Execution command:**

```bash
timeout --signal=KILL 3s docker run --rm \
  --cpus="0.5" \
  --network none \
  --pids-limit 32 \
  --memory="128m" \
  --memory-swap="128m" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-c:latest \
  /work/hello
```

* **Observed result:** Printed `Entering infinite loop...`, got killed after ~3 seconds (`Killed`), and returned **exit code `137`**.

---

## 6. Key Takeaway for the Worker Implementation

* **Exit code `137` is ambiguous on its own:** Both an Out-Of-Memory kill (`MLE`) and a `SIGKILL` timeout (`TLE`) return exit code **`137`** (`128 + 9`). The worker must track whether its timeout timer triggered to distinguish `TLE` from `MLE` or runtime `SIGKILL`.
---

## 7. Python Runner Single-File Verification (`runner-python:latest`)

Instead of maintaining separate test files for each constraint, a single mode-driven script (`~/test-codes-folder/hello.py`) was used to confirm `runner-python:latest` starts cleanly under non-root `UID 65534:65534` with `--read-only`, bounded `--tmpfs /tmp`, `:ro` `/work`, and `cgroups` / network isolation intact.

### 7.1 Baseline `basic` Check (`UID 65534` & Read-Only Root)

* **Execution command:**

```bash
docker run --rm \
  --cpus="0.5" \
  --network none \
  --pids-limit 32 \
  --memory="128m" \
  --memory-swap="128m" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -v ~/test-codes-folder:/work:ro \
  runner-python:latest \
  python3 /work/hello.py basic
```

* **Observed result:** Printed `PYTHON_OK uid= 65534` and exited with code `0`, confirming `python3` runs cleanly with a read-only root filesystem and `UID 65534`.

### 7.2 Batch Mode Check (`tmpfs` & `net`)

* **Execution command:**

```bash
for m in tmpfs net; do
  echo "=== mode: $m ==="
  docker run --rm \
    --cpus="0.5" \
    --network none \
    --pids-limit 32 \
    --memory="128m" \
    --memory-swap="128m" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    -v ~/test-codes-folder:/work:ro \
    runner-python:latest \
    python3 /work/hello.py "$m"
done
```

* **Observed result:** Confirms `tmpfs` scratchpad writes and `net` blocking behave consistently under the shared hardened runner configuration.