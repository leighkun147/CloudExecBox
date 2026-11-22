# Sandbox Test Suite (`runner-c:latest` & `runner-python:latest`)

Segmented test snippets for `benchmark-server`. Each C test includes both its `:rw` compile command and its `:ro` hardened run command in the header comment; the Python test includes its hardened run command in the header comment.

---

## 1. `test_01_fs_tmpfs.c` — Read-Only `/work` & Bounded `/tmp` `tmpfs`

```c
/*
 * Compile (:rw):
 *   docker run --rm -v ~/test-codes-folder:/work:rw runner-c:latest gcc /work/test_01_fs_tmpfs.c -o /work/test_01_fs_tmpfs
 *
 * Run (:ro + --read-only + --tmpfs /tmp):
 *   docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v ~/test-codes-folder:/work:ro runner-c:latest /work/test_01_fs_tmpfs
 */
#include <stdio.h>

int main(void) {
    FILE *ro_file = fopen("/work/pwned.txt", "w");
    if (!ro_file) {
        perror("write /work failed");
    } else {
        fclose(ro_file);
    }

    FILE *tmp_file = fopen("/tmp/pwned.txt", "w");
    if (!tmp_file) {
        perror("write /tmp failed");
        return 1;
    }
    fprintf(tmp_file, "scratchpad ok\n");
    fclose(tmp_file);
    printf("write /tmp ok\n");
    return 0;
}
```

---

## 2. `test_02_memory_oom.c` — Memory Cap (`--memory` & `--memory-swap` -> Exit `137`)

```c
/*
 * Compile (:rw):
 *   docker run --rm -v ~/test-codes-folder:/work:rw runner-c:latest gcc /work/test_02_memory_oom.c -o /work/test_02_memory_oom
 *
 * Run (128m memory/swap cap -> OOM SIGKILL / exit 137):
 *   docker run --rm --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v ~/test-codes-folder:/work:ro runner-c:latest /work/test_02_memory_oom
 */
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    size_t bytes = 256 * 1024 * 1024; // 256 MB > 128m cap
    char *buf = malloc(bytes);
    if (!buf) {
        perror("malloc failed");
        return 1;
    }
    for (size_t i = 0; i < bytes; i += 4096) {
        buf[i] = 'A';
    }
    printf("allocated 256 MB\n");
    free(buf);
    return 0;
}
```

---

## 3. `test_03_pids_limit.c` — Process / PID Cap (`--pids-limit` -> `EAGAIN`)

```c
/*
 * Compile (:rw):
 *   docker run --rm -v ~/test-codes-folder:/work:rw runner-c:latest gcc /work/test_03_pids_limit.c -o /work/test_03_pids_limit
 *
 * Run (--pids-limit 32 -> spawns 31 children + 1 parent = 32, then EAGAIN):
 *   docker run --rm --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v ~/test-codes-folder:/work:ro runner-c:latest /work/test_03_pids_limit
 */
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    int spawned = 0;
    for (int i = 0; i < 50; i++) {
        pid_t pid = fork();
        if (pid < 0) {
            perror("fork failed");
            break;
        } else if (pid == 0) {
            _exit(0);
        } else {
            spawned++;
        }
    }
    while (wait(NULL) > 0) {}
    printf("spawned=%d\n", spawned);
    return 0;
}
```

---

## 4. `test_04_network_none.c` — Network Isolation (`--network none` -> `ENETUNREACH`)

```c
/*
 * Compile (:rw):
 *   docker run --rm -v ~/test-codes-folder:/work:rw runner-c:latest gcc /work/test_04_network_none.c -o /work/test_04_network_none
 *
 * Run (--network none -> connect returns Network unreachable):
 *   docker run --rm --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v ~/test-codes-folder:/work:ro runner-c:latest /work/test_04_network_none
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        perror("socket failed");
        return 1;
    }
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(80);
    inet_pton(AF_INET, "1.1.1.1", &addr.sin_addr);

    if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("connect failed");
        close(sock);
        return 0;
    }
    printf("connected\n");
    close(sock);
    return 0;
}
```

---

## 5. `test_05_cpu_quota.c` — CPU Quota Throttling (`--cpus="0.5"` vs. `--cpus="2.0"`)

```c
/*
 * Compile (:rw):
 *   docker run --rm -v ~/test-codes-folder:/work:rw runner-c:latest gcc /work/test_05_cpu_quota.c -O2 -o /work/test_05_cpu_quota
 *
 * Run (--cpus="0.5" -> throttled ~19.01s; swap to --cpus="2.0" -> ~4.52s):
 *   docker run --rm --cpus="0.5" --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v ~/test-codes-folder:/work:ro runner-c:latest /work/test_05_cpu_quota
 */
#include <stdio.h>
#include <time.h>

int main(void) {
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);

    volatile unsigned long long acc = 0;
    for (unsigned long long i = 0; i < 20000000000ULL; i++) {
        acc += (i * 3ULL) ^ 0x5a5a5a5aULL;
    }

    clock_gettime(CLOCK_MONOTONIC, &end);
    double elapsed = (end.tv_sec - start.tv_sec) + (end.tv_nsec - start.tv_nsec) / 1e9;
    printf("acc=%llu elapsed=%.2fs\n", acc, elapsed);
    return 0;
}
```

---

## 6. `test_06_timeout_loop.c` — Execution Timeout on Infinite Loop (`timeout --signal=KILL` -> Exit `137`)

```c
/*
 * Compile (:rw):
 *   docker run --rm -v ~/test-codes-folder:/work:rw runner-c:latest gcc /work/test_06_timeout_loop.c -o /work/test_06_timeout_loop
 *
 * Run (3s hard SIGKILL timeout -> exit 137):
 *   timeout --signal=KILL 3s docker run --rm --cpus="0.5" --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v ~/test-codes-folder:/work:ro runner-c:latest /work/test_06_timeout_loop
 */
#include <stdio.h>

int main(void) {
    printf("entering infinite loop\n");
    fflush(stdout);
    while (1) {}
    return 0;
}
```

---

## 7. `test_07_python_probe.py` — Single-File Python Runner Check (`runner-python:latest`)

```python
"""
Run (single-file check as UID 65534:65534 under hardened container flags):
  docker run --rm --cpus="0.5" --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v ~/test-codes-folder:/work:ro runner-python:latest python3 /work/test_07_python_probe.py basic
"""
import os
import socket
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "basic"

if mode == "basic":
    print("PYTHON_OK uid=", os.getuid(), flush=True)
elif mode == "tmpfs":
    try:
        with open("/tmp/py_probe.txt", "w") as f:
            f.write("ok\n")
        print("TMPFS_WRITE_OK", flush=True)
    except OSError as e:
        print("TMPFS_BLOCKED:", e, flush=True)
elif mode == "net":
    try:
        s = socket.create_connection(("1.1.1.1", 80), timeout=2)
        s.close()
        print("NET_OPEN_OK", flush=True)
    except OSError as e:
        print("NET_BLOCKED:", e.errno, e.strerror, flush=True)
else:
    print("UNKNOWN_MODE:", mode, flush=True)
```