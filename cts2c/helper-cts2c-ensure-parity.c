// RP2350 C harness — runs a transpiled RP2350 emulator against a firmware image and
// prints the same per-block PC-trace CRC32 checksums as demo/perf-bench.ts, so the two
// runs can be bisected against each other on deviation instead of diffing full PC traces.
//
// Usage: rp2350-harness [firmware.hex] [targetCycles] [blockSize] [quietUntilStep] [dumpStart] [dumpCount] [coreArch]
//   blockSize     — steps per CRC block (default 1000000)
//   quietUntilStep — suppress pc_trace output before this step (default 0)
//   dumpStart     — if >0, dump PC + registers per step starting at this step (disables CRC mode)
//   dumpCount     — number of steps to dump (default 100)
//   coreArch      — "riscv" (default) or "arm". Appended as the LAST positional arg
//                   (rather than inserted earlier) so every existing call site that
//                   passes fewer args keeps today's default (riscv) behavior unchanged.
//                   For "arm", the dump format still reports 32 "x" registers to match
//                   the existing side-by-side dump layout, but only x0-x15 are real
//                   (ARM's r0-r12/SP/LR/PC); x16-x31 are always 0.
#include "../build/transpile/rp2350js-c.h"
#include <time.h>

static uint32_t crc32_table[256];

static void crc32_init(void) {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320u ^ (c >> 1)) : (c >> 1);
    crc32_table[n] = c;
  }
}

static uint32_t crc32_update_u32le(uint32_t crc, uint32_t value) {
  for (int i = 0; i < 4; i++) {
    uint8_t byte = (uint8_t)((value >> (i * 8)) & 0xff);
    crc = crc32_table[(crc ^ byte) & 0xff] ^ (crc >> 8);
  }
  return crc;
}

int main(int argc, char** argv) {
  const char* firmwarePath = argc > 1 ? argv[1] : "demo/riscv_blink/blink_simple.hex";
  long targetCycles = argc > 2 ? atol(argv[2]) : 50000000;
  long blockSize = argc > 3 ? atol(argv[3]) : 1000000;
  long quietUntilStep = argc > 4 ? atol(argv[4]) : 0;
  long dumpStart = argc > 5 ? atol(argv[5]) : 0;
  long dumpCount = argc > 6 ? atol(argv[6]) : 100;
  const char* coreArch = argc > 7 ? argv[7] : NULL; // NULL -> RP2350's own "riscv" default
  int isArm = coreArch && strcmp(coreArch, "arm") == 0;

  crc32_init();

  RP2350Options options = { .coreArch = coreArch, .loadFirmware = firmwarePath };
  RP2350* mcu = RP2350_new(&options);

  // Exactly one of these is valid, chosen by isArm — .obj is the same underlying
  // pointer either way (mcu->core[0] is the ICpuCore fat pointer RP2350 actually
  // constructed), this just picks which concrete type to view it as.
  CPU* core0 = isArm ? NULL : (CPU*)(mcu->core[0].obj);
  CortexM33Core* core0m33 = isArm ? (CortexM33Core*)(mcu->core[0].obj) : NULL;

  int dumpMode = dumpStart > 0;
  long dumpEnd = dumpStart + dumpCount;

  long steps = 0;
  uint32_t blockCrc = 0xffffffff;
  long blockSteps = 0;
  long blockIndex = 0;

  clock_t t0 = clock();
  while (RP2350_cycles_get(mcu) < targetCycles) {
    RP2350_step(mcu);
    steps++;

    // CPU.pc is a plain field; CortexM33Core.PC is getter-backed (returns
    // regs.pc, itself also a getter over r[15]) — no struct member to read
    // directly for the ARM case, has to go through the real accessor.
    uint32_t pc = isArm ? (uint32_t)CortexM33Core_PC_get(core0m33) : (uint32_t)core0->pc;

    if (dumpMode) {
      if (steps >= dumpStart && steps < dumpEnd) {
        fprintf(stderr, "DUMP step=%ld pc=0x%08x", steps, pc);
        if (isArm) {
          // ARM has only 16 real registers (r0-r12, sp, lr, pc); pad the rest so the
          // dump format matches RISC-V's 32-register layout the parity script parses.
          for (int i = 0; i < 16; i++)
            fprintf(stderr, " x%d=0x%08x", i, (uint32_t)core0m33->regs->r[i]);
          for (int i = 16; i < 32; i++) fprintf(stderr, " x%d=0x%08x", i, 0u);
        } else {
          for (int i = 0; i < 32; i++)
            fprintf(stderr, " x%d=0x%08x", i, (uint32_t)core0->registerSet->regs[i]);
        }
        fprintf(stderr, "\n");
      }
      if (steps >= dumpEnd) break;
      continue;
    }

    blockCrc = crc32_update_u32le(blockCrc, pc);
    blockSteps++;
    if (blockSteps == blockSize) {
      if (steps > quietUntilStep)
        fprintf(stderr, "pc_trace block=%ld steps=%ld cycles=%d crc32=0x%08x\n",
                blockIndex, blockSteps, RP2350_cycles_get(mcu), blockCrc ^ 0xffffffffu);
      blockIndex++;
      blockSteps = 0;
      blockCrc = 0xffffffff;
    }
  }
  if (!dumpMode && blockSteps > 0 && steps > quietUntilStep) {
    fprintf(stderr, "pc_trace block=%ld steps=%ld cycles=%d crc32=0x%08x\n",
            blockIndex, blockSteps, RP2350_cycles_get(mcu), blockCrc ^ 0xffffffffu);
  }

  double elapsed_ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
  if (!dumpMode)
    fprintf(stderr, "cycles=%d steps=%ld elapsed_ms=%.1f cycles_per_sec=%.0f\n",
            RP2350_cycles_get(mcu), steps, elapsed_ms, elapsed_ms > 0 ? (RP2350_cycles_get(mcu) / elapsed_ms) * 1000.0 : 0.0);
  return 0;
}
