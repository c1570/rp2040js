/**
 * IEEE 754 single-precision flag computation for VFPv5-SP.
 *
 * JS `number` is binary64; we use Math.fround for binary32 rounding but must
 * detect exceptional cases explicitly since JS loses sign-of-zero and NaN
 * payload semantics.
 */

import { Float32 } from '../utils/types';

const INF = Infinity;
const NEG_INF = -Infinity;
const QNAN = NaN;

/** FPSCR exception flag bits. */
export const FPSCR_IOC = 1 << 0; // invalid operation
export const FPSCR_DZC = 1 << 1; // divide by zero
export const FPSCR_OFC = 1 << 2; // overflow
export const FPSCR_UFC = 1 << 3; // underflow
export const FPSCR_IXC = 1 << 4; // inexact
export const FPSCR_IDC = 1 << 7; // input denormal

/**
 * Out-parameter for the f32add/f32sub/f32mul/f32div/f32fma/f32sqrt/checkInput/
 * postProcess family below. cts2c has no support for array-destructuring assignment:
 * it evaluates the call for side effects and silently leaves the target vars
 * untouched, so a `[result, fpscr] = f32add(...)` would lose both. Caller-owned and
 * reused across calls (no allocation in C). Reusing the same struct as internal
 * scratch is safe — every function reads `out.value`/`out.fpscr` back into locals
 * immediately after writing them, so nothing is read after a later call overwrites it.
 */
export interface FpResult {
  value: Float32;
  fpscr: number;
}

/** Pack N/Z/C/V into FPSCR bits [31:28]. */
export function setFpscrNzcv(
  fpscr: number,
  n: boolean,
  z: boolean,
  c: boolean,
  v: boolean
): number {
  return (
    (fpscr & ~0xf0000000) |
    (n ? 0x80000000 : 0) |
    (z ? 0x40000000 : 0) |
    (c ? 0x20000000 : 0) |
    (v ? 0x10000000 : 0)
  );
}

/** Check if a float32 value is denormal (subnormal). */
function isDenormal(f: Float32): boolean {
  return f !== 0 && Math.abs(f) < 1.1754943508222875e-38; // smallest normal
}

/** Check FZ (flush-to-zero) and set IDC if input was denormal. */
export function checkInput(f: Float32, fpscr: number, out: FpResult): void {
  if (isDenormal(f)) {
    // IDC accumulates on ANY denormal input, regardless of FZ (ARM §B3.4.4).
    fpscr |= FPSCR_IDC;
    if ((fpscr & 0x100) !== 0) {
      // FZ=1: flush to signed zero, preserving the sign bit.
      out.value = f < 0 ? -0 : 0;
      out.fpscr = fpscr;
      return;
    }
  }
  out.value = f;
  out.fpscr = fpscr;
}

/**
 * VFP compare (VCMP/VCMP.E). Sets FPSCR NZCV.
 * On M33: compares with NaN (unordered) → N=0 Z=0 C=1 V=1, plus IOC.
 */
export function f32cmp(fpscr: number, a: Float32, b: Float32): number {
  if (isNaN(a) || isNaN(b)) {
    // Unordered: N=0 Z=0 C=1 V=1 (C set so BGE/BHI see unordered as true).
    fpscr = setFpscrNzcv(fpscr, false, false, true, true);
    return fpscr | FPSCR_IOC;
  }
  // Plain sequential assignments, not array-destructuring (cts2c has no support
  // for it — see cts2c.js's array-destructuring-assignment TODO stub).
  let n: boolean, z: boolean, c: boolean, v: boolean;
  if (a < b) {
    n = true;
    z = false;
    c = false;
    v = false;
  } else if (a > b) {
    n = false;
    z = false;
    c = true;
    v = false;
  } else {
    n = false;
    z = true;
    c = true;
    v = false;
  }
  return setFpscrNzcv(fpscr, n, z, c, v);
}

/** F32 add/sub/mul/div with IEEE flag detection. */
export function f32add(fpscr: number, a: Float32, b: Float32, out: FpResult): void {
  checkInput(a, fpscr, out);
  a = out.value;
  fpscr = out.fpscr;
  checkInput(b, fpscr, out);
  b = out.value;
  fpscr = out.fpscr;
  const result = Math.fround(a + b);
  postProcess(result, a, b, fpscr, 'add', out);
}

export function f32sub(fpscr: number, a: Float32, b: Float32, out: FpResult): void {
  f32add(fpscr, a, -b, out);
}

export function f32mul(fpscr: number, a: Float32, b: Float32, out: FpResult): void {
  checkInput(a, fpscr, out);
  a = out.value;
  fpscr = out.fpscr;
  checkInput(b, fpscr, out);
  b = out.value;
  fpscr = out.fpscr;
  const result = Math.fround(a * b);
  postProcess(result, a, b, fpscr, 'mul', out);
}

export function f32div(fpscr: number, a: Float32, b: Float32, out: FpResult): void {
  checkInput(a, fpscr, out);
  a = out.value;
  fpscr = out.fpscr;
  checkInput(b, fpscr, out);
  b = out.value;
  fpscr = out.fpscr;
  if (b === 0 && a !== 0 && !isNaN(a)) {
    fpscr |= FPSCR_DZC;
    // Native a/b yields a correctly-signed infinity (JS division preserves the
    // sign of the zero divisor, unlike a Math.sign() product).
    out.value = a / b;
    out.fpscr = fpscr;
    return;
  }
  const result = Math.fround(a / b);
  postProcess(result, a, b, fpscr, 'div', out);
}

/**
 * Fused multiply-add family (VFMA/VFMS/VFNMA/VFNMS): `signedAddend +/-
 * (a*b)`, computed with a *single* rounding step. `a*b` is exact in
 * double-precision JS math (the exact product of two float32-valued inputs
 * always fits in a double's 53-bit mantissa), so rounding only the final sum
 * via Math.fround reproduces real fused semantics — unlike separate
 * VMUL+VADD, which would round the product to float32 first.
 */
export function f32fma(
  fpscr: number,
  addend: Float32,
  a: Float32,
  b: Float32,
  negateAddend: boolean,
  negateProduct: boolean,
  out: FpResult
): void {
  checkInput(addend, fpscr, out);
  addend = out.value;
  fpscr = out.fpscr;
  checkInput(a, fpscr, out);
  a = out.value;
  fpscr = out.fpscr;
  checkInput(b, fpscr, out);
  b = out.value;
  fpscr = out.fpscr;
  // 0 * Infinity is invalid regardless of the addend (matches f32mul/postProcess's check).
  if ((a === 0 || b === 0) && (Math.abs(a) === INF || Math.abs(b) === INF)) {
    fpscr |= FPSCR_IOC;
  }
  let product = a * b;
  if (negateProduct) product = -product;
  const signedAddend = negateAddend ? -addend : addend;
  const result = Math.fround(signedAddend + product);
  postProcess(result, signedAddend, product, fpscr, 'add', out);
}

export function f32sqrt(fpscr: number, a: Float32, out: FpResult): void {
  checkInput(a, fpscr, out);
  a = out.value;
  fpscr = out.fpscr;
  if (a < 0 && !isNaN(a)) {
    out.value = QNAN;
    out.fpscr = fpscr | FPSCR_IOC;
    return;
  }
  const result = Math.fround(Math.sqrt(a));
  postProcess(result, a, 0, fpscr, 'sqrt', out);
}

/** Detect overflow/underflow/inexact and update flags. */
function postProcess(
  result: Float32,
  a: Float32,
  b: Float32,
  fpscr: number,
  op: string,
  out: FpResult
): void {
  if (isNaN(result)) {
    if (
      op === 'mul' &&
      (a === 0 || b === 0) &&
      (a === INF || b === INF || a === NEG_INF || b === NEG_INF)
    ) {
      fpscr |= FPSCR_IOC;
    }
    out.value = result;
    out.fpscr = fpscr;
    return;
  }
  if (Math.abs(result) === INF) {
    fpscr |= FPSCR_OFC | FPSCR_IXC;
    out.value = result;
    out.fpscr = fpscr;
    return;
  }
  if (isDenormal(result)) {
    if (fpscr & 0x100) {
      // Flush-to-zero: return signed zero.
      fpscr |= FPSCR_UFC | FPSCR_IDC;
      out.value = result < 0 ? -0 : 0;
      out.fpscr = fpscr;
      return;
    }
    fpscr |= FPSCR_UFC | FPSCR_IXC;
    out.value = result;
    out.fpscr = fpscr;
    return;
  }
  out.value = result;
  out.fpscr = fpscr;
}
