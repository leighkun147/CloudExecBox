/*
 * Compile (:rw):
 *   docker run --rm -v "$(pwd)/test codes:/work:rw" runner-c:latest gcc /work/test_01_fs_tmpfs.c -o /work/test_01_fs_tmpfs
 *
 * Run (:ro + --read-only + --tmpfs /tmp):
 *   docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$(pwd)/test codes:/work:ro" runner-c:latest /work/test_01_fs_tmpfs
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
