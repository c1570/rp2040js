/**
 * Marker type for a 32-bit unsigned value. cts2c uses this name to emit `uint32_t`
 * instead of `int32_t`, ensuring unsigned C semantics for comparisons.
 */
export type Uint32 = number;

/**
 * Marker type for an IEEE-754 binary32 (float32) value. cts2c uses this name to emit
 * `float` instead of `int32_t`, preventing truncation of float32 values.
 */
export type Float32 = number;

/**
 * Marker type for an IEEE-754 binary64 (double) with fractional data. cts2c emits
 * `double` for this instead of `int32_t`, preserving fractional values.
 */
export type Float64 = number;

/**
 * Marker type for an integer that can exceed int32 range but stays within JS's
 * exact-integer-safe range (±2^53). cts2c emits `int64_t` for this.
 */
export type Int53 = number;

/**
 * Float64Array-backed 53-bit-safe integer array. JS stores packed 53-bit ints in a
 * Float64 (exactly represents integers up to 2^53); cts2c emits `uint64_t*` for it
 * (see the regex in cts2c.js's typed-array handling + the Int53Array case in
 * typedArrayCType). Pack/unpack via the int53Pack/int53High helpers below.
 */
export const Int53Array = Float64Array;
export type Int53Array = Float64Array;

/**
 * Upper 21 bits of a packed Int53 value. cts2c intrinsic → ((uint32_t)((uint64_t)x >> 32)).
 * The JS form uses float division to avoid the ToInt32 truncation JS applies to its
 * bitwise operators on values >2^31 (which a packed decode entry always exceeds).
 */
export function int53High(packed: Int53): number {
  return Math.floor(packed / 4294967296) | 0;
}

/**
 * Combine the low 32 bits and the upper 21 bits into one packed value.
 * cts2c intrinsic → ((uint64_t)(uint32_t)lo | ((uint64_t)(uint32_t)hi << 32)).
 * Same ToInt32-truncation reason as int53High for the JS form.
 */
export function int53Pack(low: number, high: number): Int53 {
  return (low >>> 0) + high * 4294967296;
}
