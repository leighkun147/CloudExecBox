/*
 * Compile (:rw):
 *   docker run --rm -v "$(pwd)/test codes:/work:rw" runner-c:latest gcc /work/test_04_network_none.c -o /work/test_04_network_none
 *
 * Run (--network none -> connect returns Network unreachable):
 *   docker run --rm --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$(pwd)/test codes:/work:ro" runner-c:latest /work/test_04_network_none
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
