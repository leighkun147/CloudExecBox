/*
 * Compile (:rw):
 *   docker run --rm -v "$(pwd)/test codes:/work:rw" runner-c:latest gcc /work/test_05_cpu_quota.c -O2 -o /work/test_05_cpu_quota
 *
 * Run (--cpus="0.5" -> throttled ~19.01s; swap to --cpus="2.0" -> ~4.52s):
 *   docker run --rm --cpus="0.5" --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$(pwd)/test codes:/work:ro" runner-c:latest /work/test_05_cpu_quota
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
