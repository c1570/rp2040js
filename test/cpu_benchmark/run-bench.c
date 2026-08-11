// CPU benchmark runner — C emulator (transpiled from TS via cts2c).
// Runs cpu_benchmark firmware on RP2040 / RP2350-ARM / RP2350-RISC-V,
// captures UART output, measures cycles/sec.
//
// Build: gcc -O3 -Wall test/cpu_benchmark/run-bench.c -o build/transpile/cpu-bench -lm
//   (run from repo root; the #include path is relative to repo root via -I.)
// Usage: build/transpile/cpu-bench [targetCycles]
#include "rp2350js-c.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define LINE_BUF 256
#define MAX_LINES 64

typedef struct {
  char lines[MAX_LINES][LINE_BUF];
  int count;
  long long cycles;
  double cycles_per_sec;
} BenchResult;

static char line_buf[LINE_BUF];
static int line_len = 0;
static BenchResult* g_result = NULL;

static void on_uart_byte(void* ctx, int32_t value) {
  (void)ctx;
  if (!g_result) return;
  if (value == '\n') {
    line_buf[line_len] = '\0';
    // Only store lines starting with "iter="
    if (strncmp(line_buf, "iter=", 5) == 0 && g_result->count < MAX_LINES) {
      strncpy(g_result->lines[g_result->count], line_buf, LINE_BUF - 1);
      g_result->lines[g_result->count][LINE_BUF - 1] = '\0';
      g_result->count++;
    }
    line_len = 0;
  } else if (line_len < LINE_BUF - 1) {
    line_buf[line_len++] = (char)value;
  }
}

static BenchResult run_rp2040(const char* hexPath, long long targetCycles) {
  BenchResult r = {0};
  g_result = &r;
  line_len = 0;

  RP2040Options opts = {.loadFirmware = NULL};
  RP2040* mcu = RP2040_new(&opts);
  LoadFirmwareOptions lfo = {.entryPc = 0x10000000};
  RP2040_loadFirmware(mcu, hexPath, &lfo);
  mcu->core[1]->waiting = true;
  mcu->uart[0]->onByte_fn = on_uart_byte;

  clock_t t0 = clock();
  while (RP2040_cycles_get(mcu) < targetCycles) {
    RP2040_step(mcu);
  }
  double elapsed_ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
  r.cycles = RP2040_cycles_get(mcu);
  r.cycles_per_sec = elapsed_ms > 0 ? (r.cycles / elapsed_ms) * 1000.0 : 0.0;
  return r;
}

static BenchResult run_rp2350(const char* hexPath, long long targetCycles, const char* coreArch) {
  BenchResult r = {0};
  g_result = &r;
  line_len = 0;

  RP2350Options opts = {.coreArch = coreArch, .loadFirmware = hexPath};
  RP2350* mcu = RP2350_new(&opts);
  mcu->uart[0]->onByte_fn = on_uart_byte;

  clock_t t0 = clock();
  while (RP2350_cycles_get(mcu) < targetCycles) {
    RP2350_step(mcu);
  }
  double elapsed_ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
  r.cycles = RP2350_cycles_get(mcu);
  r.cycles_per_sec = elapsed_ms > 0 ? (r.cycles / elapsed_ms) * 1000.0 : 0.0;
  return r;
}

int main(int argc, char** argv) {
  long long targetCycles = argc > 1 ? atoll(argv[1]) : 200000000;

  const char* fw_rp2040 = "test/cpu_benchmark/cpu_benchmark_rp2040.hex";
  const char* fw_arm = "test/cpu_benchmark/cpu_benchmark_rp2350_arm.hex";
  const char* fw_riscv = "test/cpu_benchmark/cpu_benchmark_rp2350_riscv.hex";

  BenchResult rp2040 = run_rp2040(fw_rp2040, targetCycles);
  BenchResult arm = run_rp2350(fw_arm, targetCycles, "arm");
  BenchResult riscv = run_rp2350(fw_riscv, targetCycles, "riscv");

  printf("\n=== C Emulator Results ===\n\n");
  const char* labels[] = {"rp2040", "arm", "riscv"};
  BenchResult* results[] = {&rp2040, &arm, &riscv};
  for (int i = 0; i < 3; i++) {
    printf("%s: %.0f cycles/sec\n", labels[i], results[i]->cycles_per_sec);
    for (int j = 0; j < results[i]->count && j < 3; j++)
      printf("  %s\n", results[i]->lines[j]);
    if (results[i]->count > 3)
      printf("  ... (%d total)\n", results[i]->count);
    printf("\n");
  }

  printf("---JSON---\n");
  printf("{\"targetCycles\":%lld,\"results\":{", targetCycles);
  for (int i = 0; i < 3; i++) {
    if (i > 0) printf(",");
    printf("\"%s\":{\"lines\":[", labels[i]);
    for (int j = 0; j < results[i]->count; j++) {
      if (j > 0) printf(",");
      printf("\"%s\"", results[i]->lines[j]);
    }
    printf("],\"cyclesPerSec\":%.0f}", results[i]->cycles_per_sec);
  }
  printf("}}\n");
  return 0;
}
