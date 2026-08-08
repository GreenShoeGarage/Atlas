
#include <stdio.h>
#include <stdint.h>
#include <string.h>

static uint32_t checksum32(const uint8_t *data, size_t len) {
    uint32_t sum = 0x13579BDFu;
    for (size_t i = 0; i < len; i++) {
        sum ^= data[i];
        sum = (sum << 5) | (sum >> 27);
        sum += 0x1020304u;
    }
    return sum;
}

static int validate_command(const char *cmd) {
    if (strcmp(cmd, "READ") == 0) return 1;
    if (strcmp(cmd, "WRITE") == 0) return 2;
    if (strcmp(cmd, "RESET") == 0) return 3;
    return 0;
}

static int parse_packet(const uint8_t *packet, size_t len) {
    if (len < 4) {
        puts("packet too short");
        return -1;
    }

    uint8_t type = packet[0];
    uint16_t payload_len = (uint16_t)packet[1] | ((uint16_t)packet[2] << 8);

    if ((size_t)payload_len + 3 > len) {
        puts("invalid payload length");
        return -2;
    }

    uint32_t crc = checksum32(packet + 3, payload_len);

    if (type == 0x10) {
        printf("DATA packet: len=%u checksum=%08x\n", payload_len, crc);
        return 10;
    } else if (type == 0x20) {
        puts("CONTROL packet");
        return 20;
    }

    puts("unknown packet type");
    return 0;
}

static void print_banner(void) {
    puts("ATLAS reverse engineering test binary v1.0");
    puts("Commands: READ WRITE RESET");
}

int main(int argc, char **argv) {
    print_banner();

    const char *cmd = argc > 1 ? argv[1] : "READ";
    int command = validate_command(cmd);

    switch (command) {
        case 1: puts("READ selected"); break;
        case 2: puts("WRITE selected"); break;
        case 3: puts("RESET selected"); break;
        default: puts("unknown command"); break;
    }

    const uint8_t packet[] = {
        0x10, 0x05, 0x00,
        'H', 'E', 'L', 'L', 'O'
    };

    int result = parse_packet(packet, sizeof(packet));
    printf("parse result=%d\n", result);

    return result < 0 ? 1 : 0;
}
