/*
 * RP2040 CPU Benchmark — Cortex-M0+ opcode throughput.
 *
 * Four compute kernels (GCD/CRC32, FNV-1a hash, insertion sort) exercising
 * integer arithmetic, bit operations, byte/word memory access, conditional
 * branches, and software division. Each kernel accumulates into a uint32_t
 * checksum; checksums are printed via UART every PRINT_INTERVAL iterations.
 *
 * Build: see CMakeLists.txt (PICO_PLATFORM=rp2040, pico_stdlib, UART stdio).
 * Single core, no peripherals beyond UART, no SDK timer — pure CPU work.
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "pico/stdlib.h"

/* Iterations between UART output lines. Tuned so each batch is ~50M cycles
 * on a 125 MHz M0+ (~110k cycles/iter; 450 ≈ 49.5M cycles). */
#define PRINT_INTERVAL 450

/* ---- xorshift32 PRNG (deterministic, exercises shifts/XOR/AND) ---------- */

static uint32_t xorshift32_state = 0x12345678u;

static inline uint32_t xorshift32(void) {
    uint32_t x = xorshift32_state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    xorshift32_state = x;
    return x;
}

/* ---- Kernel 1: GCD over a sliding range -------------------------------- *
 * Exercises: SUB, MUL, CMP, conditional branches (BNE/BLT/BGE), BL calls.
 * Uses % which compiles to __aeabi_idivmod — a long M0+ shift-subtract loop. */

static uint32_t bench_arith(uint32_t seed) {
    uint32_t acc = seed;
    for (int i = 1; i <= 32; i++) {
        for (int j = i + 1; j <= 32; j++) {
            int a = i, b = j;
            while (b != 0) {       /* Euclid */
                int t = a % b;
                a = b;
                b = t;
            }
            acc += (uint32_t)a * (uint32_t)(j - i + 1);
        }
    }
    return acc;
}

/* ---- Kernel 2: CRC32 over a mutating buffer ---------------------------- *
 * Exercises: XOR, AND, ORR, LSR, LDRB, conditional branches, TST. */

static uint32_t crc32_tableless(const uint8_t *data, int len, uint32_t crc) {
    crc = ~crc;
    for (int i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            uint32_t mask = -(crc & 1);
            crc = (crc >> 1) ^ (0xEDB88320u & mask);
        }
    }
    return ~crc;
}

static uint8_t crc_buf[128];

static uint32_t bench_bitops(uint32_t seed) {
    /* Mutate the buffer deterministically each call. */
    for (int i = 0; i < (int)sizeof(crc_buf); i++) {
        crc_buf[i] = (uint8_t)(xorshift32() >> (i & 7));
    }
    uint32_t crc = crc32_tableless(crc_buf, sizeof(crc_buf), seed);
    return crc;
}

/* ---- Kernel 3: FNV-1a hash + xorshift mix ------------------------------ *
 * Exercises: MUL, XOR, ADD, LDRB, byte-granular memory access. */

static uint8_t hash_buf[256];

static uint32_t bench_hash(uint32_t seed) {
    /* Re-seed the buffer from xorshift so bytes differ each call. */
    for (int i = 0; i < (int)sizeof(hash_buf); i += 4) {
        uint32_t v = xorshift32() ^ seed;
        hash_buf[i]     = (uint8_t)(v);
        hash_buf[i + 1] = (uint8_t)(v >> 8);
        hash_buf[i + 2] = (uint8_t)(v >> 16);
        hash_buf[i + 3] = (uint8_t)(v >> 24);
    }
    uint32_t hash = 0x811c9dc5u;
    for (int i = 0; i < (int)sizeof(hash_buf); i++) {
        hash ^= hash_buf[i];
        hash *= 0x01000193u;
    }
    return hash;
}

/* ---- Kernel 4: Insertion sort on a shuffled array ---------------------- *
 * Exercises: LDR/STR (word), CMP, conditional branches, address arithmetic. */

#define SORT_N 32
static uint32_t sort_buf[SORT_N];

static uint32_t bench_sort(uint32_t seed) {
    /* Fill with pseudo-random values (xorshift). */
    for (int i = 0; i < SORT_N; i++) {
        sort_buf[i] = xorshift32() ^ seed;
    }
    /* Insertion sort. */
    for (int i = 1; i < SORT_N; i++) {
        uint32_t key = sort_buf[i];
        int j = i - 1;
        while (j >= 0 && sort_buf[j] > key) {
            sort_buf[j + 1] = sort_buf[j];
            j--;
        }
        sort_buf[j + 1] = key;
    }
    /* Mix sorted values into a checksum. */
    uint32_t acc = 0;
    for (int i = 0; i < SORT_N; i++) {
        acc = (acc << 3) | (acc >> 29);
        acc ^= sort_buf[i] + (uint32_t)i;
    }
    return acc;
}

/* ------------------------------------------------------------------------ */

int main(void) {
    stdio_init_all();

    uint32_t arith_acc = 0, bitops_acc = 0, hash_acc = 0, sort_acc = 0;
    uint32_t iter = 0;

    for (;;) {
        arith_acc += bench_arith(iter);
        bitops_acc = bench_bitops(bitops_acc);
        hash_acc ^= bench_hash(iter + 1);
        sort_acc += bench_sort(iter + 7);

        iter++;
        if (iter % PRINT_INTERVAL == 0) {
            printf("iter=%lu arith=0x%08lx crc=0x%08lx hash=0x%08lx sort=0x%08lx\n",
                   iter, arith_acc, bitops_acc, hash_acc, sort_acc);
        }
    }

    return 0;
}
