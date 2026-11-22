/*
 * Compile (:rw):
 *   docker run --rm -v "$(pwd)/test codes:/work:rw" runner-c:latest gcc /work/test_02_memory_oom.c -o /work/test_02_memory_oom
 *
 * Run (128m memory/swap cap -> OOM SIGKILL / exit 137):
 *   docker run --rm --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$(pwd)/test codes:/work:ro" runner-c:latest /work/test_02_memory_oom
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
