// Standalone correctness check for floatToBits/bitsToFloat/isSignNegative/readDouble/
// writeDouble's hand-written C bodies (see cts2c.js's FunctionDeclaration name-override
// for these 5 functions). Exercises them directly with non-trivial (non-integer-valued)
// float/double values — deliberately NOT covered by any of the reference demos' CRC32
// parity tests, which is exactly how the pre-fix bug (wrong C parameter/return types
// causing numeric, not bit-for-bit, conversion) went undetected. Exits non-zero and
// prints a diagnostic on the first mismatch.
#include "../build/transpile/full.c"
#include <stdio.h>

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

  if (failures > 0) {
    fprintf(stderr, "\n%d check(s) FAILED\n", failures);
    return 1;
  }
  printf("\nAll bit-punning checks passed.\n");
  return 0;
}
