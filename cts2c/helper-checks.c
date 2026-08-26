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

  if (failures > 0) {
    fprintf(stderr, "\n%d check(s) FAILED\n", failures);
    return 1;
  }
  printf("\nAll helper checks passed.\n");
  return 0;
}
