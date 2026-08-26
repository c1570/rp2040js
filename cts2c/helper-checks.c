// Standalone correctness checks for C function helpers cts2c.js emits in
// place of transpiled TS (see its FunctionDeclaration name-override blocks):
//
//  - floatToBits/bitsToFloat/isSignNegative/readDouble/writeDouble's bit-punning
//    bodies, exercised with non-trivial (non-integer-valued) float/double values —
//    deliberately NOT covered by any of the reference demos' CRC32 parity tests,
//    which is exactly how the pre-fix bug (wrong C parameter/return types causing
//    numeric, not bit-for-bit, conversion) went undetected.
//  - checkTraceMagic/checkTraceMagicM33/checkTraceMagicM0's allocation-free trace
//    hook bodies: write the 0xabcd/0xffff marker + tag into (virtual) chip memory,
//    call the hook, and verify the chip's onTrace callback fires exactly once with
//    the right core number, PC and tag string.
//  - the transpiled cores' add/sub/mul/div opcodes, run as hand-assembled
//    instructions on each core (RISC-V, Cortex-M33, Cortex-M0+) with boundary
//    operands — the cases where a uint-vs-int mixup in the generated C silently
//    changes the result (see the section comment near the end for details).
//
// Exits non-zero and prints a diagnostic on the first mismatch.
#include "../build/transpile/rp2350js-c.h"
#include <stdio.h>
#include <string.h>

static int failures = 0;

static void checkU32(const char* label, uint32_t got, uint32_t want) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got 0x%08x, want 0x%08x\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: 0x%08x\n", label, got);
  }
}

static void checkF32(const char* label, float got, float want) {
  uint32_t gotBits, wantBits;
  memcpy(&gotBits, &got, sizeof(gotBits));
  memcpy(&wantBits, &want, sizeof(wantBits));
  if (gotBits != wantBits) {
    fprintf(stderr, "FAIL %s: got %.9g (0x%08x), want %.9g (0x%08x)\n", label, got, gotBits, want, wantBits);
    failures++;
  } else {
    printf("ok   %s: %.9g\n", label, got);
  }
}

static void checkF64(const char* label, double got, double want) {
  uint64_t gotBits, wantBits;
  memcpy(&gotBits, &got, sizeof(gotBits));
  memcpy(&wantBits, &want, sizeof(wantBits));
  if (gotBits != wantBits) {
    fprintf(stderr, "FAIL %s: got %.17g (0x%016llx), want %.17g (0x%016llx)\n", label, got, (unsigned long long)gotBits, want, (unsigned long long)wantBits);
    failures++;
  } else {
    printf("ok   %s: %.17g\n", label, got);
  }
}

static void checkBool(const char* label, bool got, bool want) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %d, want %d\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: %d\n", label, got);
  }
}

static void checkI32(const char* label, int32_t got, int32_t want) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %d, want %d\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: %d\n", label, got);
  }
}

static void checkStr(const char* label, const char* got, const char* want) {
  if (strcmp(got, want) != 0) {
    fprintf(stderr, "FAIL %s: got \"%s\", want \"%s\"\n", label, got, want);
    failures++;
  } else {
    printf("ok   %s: \"%s\"\n", label, got);
  }
}

// ─── add/sub/mul/div opcode checks (uint-vs-int traps) ───────────────────

// R-type with rs1=x1, rs2=x2, rd=x5.
static uint32_t rv_r(uint32_t funct3, uint32_t funct7) {
  return 0x33u | (5u << 7) | (funct3 << 12) | (1u << 15) | (2u << 20) | (funct7 << 25);
}

static uint32_t rv_alu(RP2350* mcu, CPU* cpu, uint32_t insn, uint32_t a, uint32_t b) {
  const uint32_t base = 0x20040000;
  cpu->regs[1] = (int32_t)a;
  cpu->regs[2] = (int32_t)b;
  cpu->regs[5] = 0;
  RP2350_writeUint32(mcu, base, insn);
  cpu->pc = (int32_t)base;
  cpu->next_pc = (int32_t)(base + 4);
  CPU_executeInstruction(cpu);
  return (uint32_t)cpu->regs[5];
}

// Executes a Thumb instruction (w1, plus w2 for 32-bit encodings; pass 0 for
// 16-bit ones) with r1=a, r2=b, r5 preloaded with b (MULS needs rd==rm) and
// returns r5; *hiOut (optional) receives r6 for SMULL/UMULL results.
static uint32_t m33_exec(
    RP2350* mcu, CortexM33Core* core, uint16_t w1, uint16_t w2, uint32_t a, uint32_t b, uint32_t* hiOut) {
  const uint32_t base = 0x20040000;
  core->regs->r[1] = a;
  core->regs->r[2] = b;
  core->regs->r[5] = b;
  core->regs->r[6] = 0;
  RP2350_writeUint16(mcu, base, w1);
  if (w2) RP2350_writeUint16(mcu, base + 2, w2);
  core->regs->r[15] = base;
  CortexM33Core_executeInstruction(core);
  if (hiOut) *hiOut = core->regs->r[6];
  return core->regs->r[5];
}

static uint32_t m0_exec(RP2040* mcu, CortexM0Core* core, uint16_t insn, uint32_t a, uint32_t b) {
  const uint32_t base = 0x20040000;
  core->registers[1] = a;
  core->registers[2] = b;
  core->registers[5] = b;
  RP2040_writeUint16(mcu, base, insn);
  core->registers[15] = base;
  CortexM0Core_executeInstruction(core);
  return core->registers[5];
}

// ─── checkTraceMagic* callback tests ─────────────────────────────────────

static int trace_calls = 0;
static int32_t trace_core;
static int32_t trace_pc;
static char trace_tag[128];
static void* trace_ctx_seen;

static void on_trace(void* ctx, int32_t coreNumber, int32_t pc, const char* tag) {
  (void)ctx;
  trace_calls++;
  trace_ctx_seen = ctx;
  trace_core = coreNumber;
  trace_pc = pc;
  snprintf(trace_tag, sizeof trace_tag, "%s", tag);
}

static void trace_reset(void) {
  trace_calls = 0;
  trace_ctx_seen = NULL;
  trace_core = -1;
  trace_pc = -1;
  trace_tag[0] = '\0';
}

static void rp2350_write_tag(RP2350* mcu, uint32_t addr, const char* tag) {
  size_t n = strlen(tag);
  for (size_t i = 0; i < n; i++) RP2350_writeUint8(mcu, addr + (uint32_t)i, (uint32_t)(uint8_t)tag[i]);
  RP2350_writeUint8(mcu, addr + (uint32_t)n, 0); // NUL terminator
}

static void rp2040_write_tag(RP2040* mcu, uint32_t addr, const char* tag) {
  size_t n = strlen(tag);
  for (size_t i = 0; i < n; i++) RP2040_writeUint8(mcu, addr + (uint32_t)i, (uint32_t)(uint8_t)tag[i]);
  RP2040_writeUint8(mcu, addr + (uint32_t)n, 0); // NUL terminator
}

int main(void) {
  // floatToBits/bitsToFloat: 3.14159f's real IEEE-754 bits are 0x40490FD0 — NOT the
  // bit pattern for 3.0f (0x40400000), which is what the pre-fix
  // truncate-to-int32-then-reconvert bug would have silently produced instead.
  float pi_f = 3.14159f;
  uint32_t pi_bits = 0x40490FD0u;
  checkU32("floatToBits(3.14159f)", (uint32_t)floatToBits(pi_f), pi_bits);
  checkF32("bitsToFloat(0x40490FD0)", bitsToFloat((int32_t)pi_bits), pi_f);

  // Negative fractional value.
  float neg_f = -2.5f;
  uint32_t neg_bits = 0xC0200000u;
  checkU32("floatToBits(-2.5f)", (uint32_t)floatToBits(neg_f), neg_bits);
  checkF32("bitsToFloat(0xC0200000)", bitsToFloat((int32_t)neg_bits), neg_f);

  // isSignNegative: real double bit-sign check, not a truncated-then-reconverted value.
  checkBool("isSignNegative(3.14159)", isSignNegative(3.14159), false);
  checkBool("isSignNegative(-3.14159)", isSignNegative(-3.14159), true);
  checkBool("isSignNegative(-0.0)", isSignNegative(-0.0), true);
  checkBool("isSignNegative(0.0)", isSignNegative(0.0), false);

  // readDouble/writeDouble: round-trip a genuinely fractional double through the
  // "halves" storage DCP registers actually use.
  M33CoreState st;
  uint32_t halves[16] = {0};
  st.dcpHalves = halves;
  double pi = 3.14159265358979;
  writeDouble(&st, 2, pi);
  checkF64("readDouble(writeDouble(pi))", readDouble(&st, 2), pi);

  double negVal = -123456.789;
  writeDouble(&st, 5, negVal);
  checkF64("readDouble(writeDouble(-123456.789))", readDouble(&st, 5), negVal);

  // f64ToI32Sat/f64ToU32Sat (DCP d2i/d2u): a plain `number` param truncates to
  // int32_t at the call boundary, discarding the fractional part BEFORE the
  // function's own truncate-toward-zero logic ever runs — 42.9 truncated to 42
  // (int32_t) first, then to 42 again, silently matching by coincidence; the real
  // bug shows on a value whose int32-truncated bit pattern differs from its
  // correct double-truncated one, e.g. anything requiring the saturation checks
  // to see the ORIGINAL fractional value, or simply a large fractional value.
  checkI32("f64ToI32Sat(42.9)", f64ToI32Sat(42.9), 42);
  checkI32("f64ToI32Sat(-42.9)", f64ToI32Sat(-42.9), -42);
  checkI32("f64ToI32Sat(3000000000.5)", f64ToI32Sat(3000000000.5), 0x7fffffff);
  checkU32("f64ToU32Sat(42.9)", (uint32_t)f64ToU32Sat(42.9), 42u);
  checkU32("f64ToU32Sat(5000000000.5)", (uint32_t)f64ToU32Sat(5000000000.5), 0xffffffffu);

  // ─── checkTraceMagic (RISC-V) ──────────────────────────────────────────
  // The `j` over the marker is 4 bytes, so the marker sits at the link address
  // itself (0xabcd at +0, 0xffff at +2) and the tag at +4. The hook reports the
  // cpu's CURRENT pc/mhartid — not the marker address.
  {
    RP2350Options options = {.coreArch = "riscv", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    mcu->onTrace_fn = on_trace;
    mcu->onTrace_ctx = (void*)0x1234;
    CPU* cpu = RP2350_riscvCore1_get(mcu); // core 1 proves the number is forwarded
    const uint32_t base = 0x20000000;
    RP2350_writeUint16(mcu, base, 0xabcd);
    RP2350_writeUint16(mcu, base + 2, 0xffff);
    rp2350_write_tag(mcu, base + 4, "riscv trace");
    cpu->pc = 0x20000123; // distinctive: the callback must see THIS, not `base`

    trace_reset();
    checkTraceMagic(cpu, base);
    checkI32("trace riscv fired once", trace_calls, 1);
    checkI32("trace riscv core number", trace_core, 1);
    checkI32("trace riscv pc", trace_pc, 0x20000123);
    checkStr("trace riscv tag", trace_tag, "riscv trace");
    checkBool("trace riscv ctx passthrough", trace_ctx_seen == (void*)0x1234, true);

    // Half a marker (0xffff missing) must stay silent.
    trace_reset();
    RP2350_writeUint16(mcu, base + 2, 0x0000);
    checkTraceMagic(cpu, base);
    checkI32("trace riscv no fire on bad marker", trace_calls, 0);
  }

  // ─── checkTraceMagicM33 (Cortex-M33) ───────────────────────────────────
  // Thumb `b` is 2 bytes, so the marker sits at opcodePC+2/+4 and the tag at
  // +6. The hook reports (coreIndex, opcodePC).
  {
    RP2350Options options = {.coreArch = "arm", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    mcu->onTrace_fn = on_trace;
    CortexM33Core* core = RP2350_armCore1_get(mcu);
    const uint32_t base = 0x20000100;
    RP2350_writeUint16(mcu, base + 2, 0xabcd);
    RP2350_writeUint16(mcu, base + 4, 0xffff);
    rp2350_write_tag(mcu, base + 6, "m33 trace");

    trace_reset();
    checkTraceMagicM33(core, base);
    checkI32("trace m33 fired once", trace_calls, 1);
    checkI32("trace m33 core number", trace_core, 1);
    checkI32("trace m33 pc", trace_pc, (int32_t)base);
    checkStr("trace m33 tag", trace_tag, "m33 trace");

    // Empty tag (NUL right after the marker) fires with "".
    trace_reset();
    RP2350_writeUint8(mcu, base + 6, 0);
    checkTraceMagicM33(core, base);
    checkI32("trace m33 empty tag fired", trace_calls, 1);
    checkStr("trace m33 empty tag", trace_tag, "");

    // A 70-char tag is capped at 63 chars by the 64-byte stack buffer (the C
    // body's documented divergence from the unbounded TS string building).
    trace_reset();
    char longTag[71];
    memset(longTag, 'A', sizeof longTag - 1);
    longTag[sizeof longTag - 1] = '\0';
    rp2350_write_tag(mcu, base + 6, longTag);
    char wantTag[64];
    memset(wantTag, 'A', sizeof wantTag - 1);
    wantTag[sizeof wantTag - 1] = '\0';
    checkTraceMagicM33(core, base);
    checkStr("trace m33 long tag truncated to 63", trace_tag, wantTag);

    // No marker at all must stay silent.
    trace_reset();
    RP2350_writeUint16(mcu, base + 2, 0x1234);
    checkTraceMagicM33(core, base);
    checkI32("trace m33 no fire on bad marker", trace_calls, 0);
  }

  // ─── checkTraceMagicM0 (Cortex-M0+, RP2040) ────────────────────────────
  // Same +2/+4/+6 marker layout as M33, but reads go through the M0 core's
  // own helpers and the hook reports (coreNumber, current PC).
  {
    RP2040Options options = {.loadFirmware = NULL};
    RP2040* mcu = RP2040_new(&options);
    mcu->onTrace_fn = on_trace;
    CortexM0Core* core = RP2040_core0_get(mcu);
    const uint32_t base = 0x20000000;
    RP2040_writeUint16(mcu, base + 2, 0xabcd);
    RP2040_writeUint16(mcu, base + 4, 0xffff);
    rp2040_write_tag(mcu, base + 6, "m0 trace");
    int32_t pcBefore = CortexM0Core_PC_get(core);

    trace_reset();
    checkTraceMagicM0(core, base);
    checkI32("trace m0 fired once", trace_calls, 1);
    checkI32("trace m0 core number", trace_core, 0);
    checkI32("trace m0 pc", trace_pc, pcBefore);
    checkStr("trace m0 tag", trace_tag, "m0 trace");

    // No marker must stay silent.
    trace_reset();
    RP2040_writeUint16(mcu, base + 2, 0x0000);
    checkTraceMagicM0(core, base);
    checkI32("trace m0 no fire on bad marker", trace_calls, 0);
  }

  // ─── RISC-V add/sub/mul/div (RV32IM opcodes) ───────────────────────────
  {
    RP2350Options options = {.coreArch = "riscv", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    CPU* cpu = RP2350_riscvCore0_get(mcu);

    // ADD: wrap at the signed/unsigned top.
    checkU32("rv add 0x7fffffff+1", rv_alu(mcu, cpu, rv_r(0, 0x00), 0x7fffffff, 1), 0x80000000u);
    checkU32("rv add 0xffffffff+0xffffffff", rv_alu(mcu, cpu, rv_r(0, 0x00), 0xffffffff, 0xffffffff), 0xfffffffeu);
    // SUB: borrow across zero and out of INT_MIN.
    checkU32("rv sub 0-1", rv_alu(mcu, cpu, rv_r(0, 0x20), 0, 1), 0xffffffffu);
    checkU32("rv sub 0x80000000-1", rv_alu(mcu, cpu, rv_r(0, 0x20), 0x80000000, 1), 0x7fffffffu);
    // MUL: low 32 bits only.
    checkU32("rv mul 0x10001*0x10001", rv_alu(mcu, cpu, rv_r(0, 0x01), 0x00010001, 0x00010001), 0x00020001u);
    checkU32("rv mul -1*-1", rv_alu(mcu, cpu, rv_r(0, 0x01), 0xffffffff, 0xffffffff), 1);
    checkU32("rv mul 0x80000000*2", rv_alu(mcu, cpu, rv_r(0, 0x01), 0x80000000, 2), 0);
    // MULH/MULHU/MULHSU: THE signed-vs-unsigned discriminator.
    checkU32("rv mulh INT_MIN*INT_MIN", rv_alu(mcu, cpu, rv_r(1, 0x01), 0x80000000, 0x80000000), 0x40000000u);
    checkU32("rv mulh INT_MIN*INT_MAX", rv_alu(mcu, cpu, rv_r(1, 0x01), 0x80000000, 0x7fffffff), 0xc0000000u);
    checkU32("rv mulhu 0xffffffff*0xffffffff", rv_alu(mcu, cpu, rv_r(3, 0x01), 0xffffffff, 0xffffffff), 0xfffffffeu);
    checkU32("rv mulhsu -1*0xffffffff", rv_alu(mcu, cpu, rv_r(2, 0x01), 0xffffffff, 0xffffffff), 0xffffffffu);
    // DIV: truncate toward zero, remainder takes the dividend's sign.
    checkU32("rv div -7/2", rv_alu(mcu, cpu, rv_r(4, 0x01), (uint32_t)-7, 2), 0xfffffffcu + 1); // -3
    checkU32("rv div INT_MIN/-1", rv_alu(mcu, cpu, rv_r(4, 0x01), 0x80000000, 0xffffffff), 0x80000000u);
    checkU32("rv div 7/-2", rv_alu(mcu, cpu, rv_r(4, 0x01), 7, 0xfffffffe), 0xfffffffcu + 1); // -3
    checkU32("rv divu 0xffffffff/0x10", rv_alu(mcu, cpu, rv_r(5, 0x01), 0xffffffff, 0x10), 0x0fffffffu);
    // RISC-V div-by-zero is NOT a trap: quotient all-ones, remainder = dividend.
    checkU32("rv div 5/0", rv_alu(mcu, cpu, rv_r(4, 0x01), 5, 0), 0xffffffffu);
    checkU32("rv divu 5/0", rv_alu(mcu, cpu, rv_r(5, 0x01), 5, 0), 0xffffffffu);
    checkU32("rv rem -7%2", rv_alu(mcu, cpu, rv_r(6, 0x01), (uint32_t)-7, 2), 0xffffffffu); // -1
    checkU32("rv rem 7%-2", rv_alu(mcu, cpu, rv_r(6, 0x01), 7, 0xfffffffe), 1);
    checkU32("rv rem INT_MIN%-1", rv_alu(mcu, cpu, rv_r(6, 0x01), 0x80000000, 0xffffffff), 0);
    checkU32("rv remu 0xffffffff%0x10", rv_alu(mcu, cpu, rv_r(7, 0x01), 0xffffffff, 0x10), 0xfu);
    checkU32("rv rem 5%0", rv_alu(mcu, cpu, rv_r(6, 0x01), 5, 0), 5);
    checkU32("rv remu 5%0", rv_alu(mcu, cpu, rv_r(7, 0x01), 5, 0), 5);
  }

  // ─── Cortex-M33 add/sub/mul/div (Thumb-16 + Thumb-32) ──────────────────
  // ADDS r5,r1,r2 / SUBS r5,r1,r2 / MULS r5,r1,r5 (rd==rm) / SDIV|UDIV r5,r1,r2 /
  // SMULL|UMULL r5,r6,r1,r2.
  {
    RP2350Options options = {.coreArch = "arm", .loadFirmware = NULL};
    RP2350* mcu = RP2350_new(&options);
    CortexM33Core* core = RP2350_armCore0_get(mcu);
    const uint16_t ADDS = 0x188d, SUBS = 0x1a8d, MULS = 0x434d; // rm=r2/r5, rn=r1, rd=r5
    const uint16_t SDIV_W1 = 0xfb91, UDIV_W1 = 0xfbb1, DIV_W2 = 0xf5f2; // r5 = r1 op r2
    const uint16_t SMULL_W1 = 0xfb81, UMULL_W1 = 0xfba1, MULL_W2 = 0x5602; // r5=lo, r6=hi
    uint32_t hi;

    checkU32("m33 adds 0x7fffffff+1", m33_exec(mcu, core, ADDS, 0, 0x7fffffff, 1, NULL), 0x80000000u);
    checkBool("m33 adds 0x7fffffff+1 N", M33Registers_N_get(core->regs), true);
    checkBool("m33 adds 0x7fffffff+1 V", M33Registers_V_get(core->regs), true);
    checkBool("m33 adds 0x7fffffff+1 C", M33Registers_C_get(core->regs), false);
    checkU32("m33 adds 0xffffffff+1", m33_exec(mcu, core, ADDS, 0, 0xffffffff, 1, NULL), 0);
    checkBool("m33 adds 0xffffffff+1 Z", M33Registers_Z_get(core->regs), true);
    checkBool("m33 adds 0xffffffff+1 C", M33Registers_C_get(core->regs), true); // carry, not signed ovf
    checkBool("m33 adds 0xffffffff+1 V", M33Registers_V_get(core->regs), false);
    checkU32("m33 subs 0-1", m33_exec(mcu, core, SUBS, 0, 0, 1, NULL), 0xffffffffu);
    checkBool("m33 subs 0-1 N", M33Registers_N_get(core->regs), true);
    checkBool("m33 subs 0-1 C", M33Registers_C_get(core->regs), false); // borrow
    checkU32("m33 subs 0x80000000-1", m33_exec(mcu, core, SUBS, 0, 0x80000000, 1, NULL), 0x7fffffffu);
    checkBool("m33 subs 0x80000000-1 V", M33Registers_V_get(core->regs), true);
    checkBool("m33 subs 0x80000000-1 C", M33Registers_C_get(core->regs), true); // no borrow unsigned

    checkU32("m33 muls 0x10001*0x10001", m33_exec(mcu, core, MULS, 0, 0x00010001, 0x00010001, NULL), 0x00020001u);
    checkU32("m33 muls -1*-1", m33_exec(mcu, core, MULS, 0, 0xffffffff, 0xffffffff, NULL), 1);
    checkU32("m33 smull INT_MIN*INT_MIN lo", m33_exec(mcu, core, SMULL_W1, MULL_W2, 0x80000000, 0x80000000, &hi), 0);
    checkU32("m33 smull INT_MIN*INT_MIN hi", hi, 0x40000000u);
    checkU32("m33 smull -1*1 lo", m33_exec(mcu, core, SMULL_W1, MULL_W2, 0xffffffff, 1, &hi), 0xffffffffu);
    checkU32("m33 smull -1*1 hi", hi, 0xffffffffu);
    checkU32("m33 umull 0xffffffff*0xffffffff lo", m33_exec(mcu, core, UMULL_W1, MULL_W2, 0xffffffff, 0xffffffff, &hi), 1);
    checkU32("m33 umull 0xffffffff*0xffffffff hi", hi, 0xfffffffeu);

    checkU32("m33 sdiv -7/2", m33_exec(mcu, core, SDIV_W1, DIV_W2, (uint32_t)-7, 2, NULL), (uint32_t)-3);
    checkU32("m33 sdiv INT_MIN/-1", m33_exec(mcu, core, SDIV_W1, DIV_W2, 0x80000000, 0xffffffff, NULL), 0x80000000u);
    checkU32("m33 sdiv 5/0", m33_exec(mcu, core, SDIV_W1, DIV_W2, 5, 0, NULL), 0); // untrapped: 0
    checkU32("m33 udiv 0xffffffff/0x10", m33_exec(mcu, core, UDIV_W1, DIV_W2, 0xffffffff, 0x10, NULL), 0x0fffffffu);
    checkU32("m33 udiv 5/0", m33_exec(mcu, core, UDIV_W1, DIV_W2, 5, 0, NULL), 0); // untrapped: 0
  }

  // ─── Cortex-M0+ add/sub/mul (Thumb-16; no div on this core) ────────────
  {
    RP2040Options options = {.loadFirmware = NULL};
    RP2040* mcu = RP2040_new(&options);
    CortexM0Core* core = RP2040_core0_get(mcu);
    const uint16_t ADDS = 0x188d, SUBS = 0x1a8d, MULS = 0x434d; // rm=r2/r5, rn=r1, rd=r5

    checkU32("m0 adds 0x7fffffff+1", m0_exec(mcu, core, ADDS, 0x7fffffff, 1), 0x80000000u);
    checkBool("m0 adds 0x7fffffff+1 N", core->N, true);
    checkBool("m0 adds 0x7fffffff+1 C", core->C, false);
    checkU32("m0 adds 0xffffffff+1", m0_exec(mcu, core, ADDS, 0xffffffff, 1), 0);
    checkBool("m0 adds 0xffffffff+1 Z", core->Z, true);
    checkBool("m0 adds 0xffffffff+1 C", core->C, true);
    checkU32("m0 subs 0-1", m0_exec(mcu, core, SUBS, 0, 1), 0xffffffffu);
    checkBool("m0 subs 0-1 N", core->N, true);
    checkBool("m0 subs 0-1 C", core->C, false); // borrow
    checkU32("m0 subs 0x80000000-1", m0_exec(mcu, core, SUBS, 0x80000000, 1), 0x7fffffffu);
    checkBool("m0 subs 0x80000000-1 C", core->C, true);
    checkU32("m0 muls 0x10001*0x10001", m0_exec(mcu, core, MULS, 0x00010001, 0x00010001), 0x00020001u);
    checkU32("m0 muls -1*-1", m0_exec(mcu, core, MULS, 0xffffffff, 0xffffffff), 1);
  }

  if (failures > 0) {
    fprintf(stderr, "\n%d check(s) FAILED\n", failures);
    return 1;
  }
  printf("\nAll helper checks passed.\n");
  return 0;
}
