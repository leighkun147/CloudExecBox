/*
 * Compile (:rw):
 *   docker run --rm -v "$(pwd)/test codes:/work:rw" runner-c:latest gcc /work/test_06_timeout_loop.c -o /work/test_06_timeout_loop
 *
 * Run (3s hard SIGKILL timeout -> exit 137):
 *   timeout --signal=KILL 3s docker run --rm --cpus="0.5" --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$(pwd)/test codes:/work:ro" runner-c:latest /work/test_06_timeout_loop
 */
#include <stdio.h>

int main(void) {
    printf("entering infinite loop\n");
    fflush(stdout);
    while (1) {}
    return 0;
}
