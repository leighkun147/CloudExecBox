/*
 * Compile (:rw):
 *   docker run --rm -v "$(pwd)/test codes:/work:rw" runner-c:latest gcc /work/test_03_pids_limit.c -o /work/test_03_pids_limit
 *
 * Run (--pids-limit 32 -> spawns 31 children + 1 parent = 32, then EAGAIN):
 *   docker run --rm --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$(pwd)/test codes:/work:ro" runner-c:latest /work/test_03_pids_limit
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
