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
