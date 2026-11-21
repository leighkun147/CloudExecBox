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

## 5. Next Limits to Test & Log Here

As we continue testing resource constraints on `docker run`, log each configuration and result below:

* **Memory limit (`--memory`, `--memory-swap`):** *(Pending)*
* **Process/PID limit (`--pids-limit`):** *(Pending)*
* **Network isolation (`--network none`):** *(Pending)*
* **CPU limit (`--cpus`):** *(Pending)*