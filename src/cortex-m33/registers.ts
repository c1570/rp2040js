/**
 * Cortex-M33 (ARMv8-M Mainline) register file.
 */

/** xPSR flag bit positions. */
export const XPSR_N = 0x80000000;
export const XPSR_Z = 0x40000000;
export const XPSR_C = 0x20000000;
export const XPSR_V = 0x10000000;
export const XPSR_Q = 0x08000000;
export const XPSR_T = 0x01000000;
/** GE[3:0] lives in xPSR[19:16]. */
const XPSR_GE_SHIFT = 16;
const XPSR_GE_MASK = 0x000f0000;
/** IT cond lives in xPSR[26:25], IT mask in xPSR[15:10]. */
const XPSR_IT_COND_MASK = 0x06000000;
const XPSR_IT_MASK_MASK = 0x0000fc00;
const XPSR_IT_MASK = XPSR_IT_COND_MASK | XPSR_IT_MASK_MASK;
/** IPSR (exception number) occupies xPSR[8:0]. */
const XPSR_IPSR_MASK = 0x000001ff;

/**
 * Cortex-M33 register file. R0-R15 live in a typed array for hot-path indexing;
 * special-purpose registers are individual fields for clarity.
 */
export class M33Registers {
  /** R0-R12, SP (R13), LR (R14), PC (R15). */
  readonly r = new Uint32Array(16);
  /** Combined APSR + IPSR + EPSR with IT-state bits. */
  xpsr = XPSR_T;
  primask = 0;
  basepri = 0;
  faultmask = 0;
  control = 0;
  /** Main Stack Pointer (banked). */
  msp = 0;
  /** Process Stack Pointer (banked). */
  psp = 0;
  /** Non-secure MSP (TrustZone stub — not enforced in v1). */
  msp_ns = 0;
  /** Non-secure PSP (TrustZone stub — not enforced in v1). */
  psp_ns = 0;
  /** Main Stack Pointer Limit (Armv8-M). */
  msplim = 0;
  /** Process Stack Pointer Limit (Armv8-M). */
  psplim = 0;
  msplim_ns = 0;
  psplim_ns = 0;
  primask_ns = 0;
  basepri_ns = 0;
  faultmask_ns = 0;
  control_ns = 0;
  /** FPU single-precision registers S0-S31 (when CP10/11 enabled). */
  readonly s = new Float32Array(32);
  /** FP status/control register. */
  fpscr = 0;

  // Explicit no-op constructor: cts2c only synthesizes a `_new()` for a class with its
  // own declared constructor — relying on the implicit default one (real, valid JS/TS)
  // got none at all ("implicit declaration of function ... _new").
  constructor() {}

  /** Reset to a fresh post-power-on state. T bit set (Thumb always). */
  reset() {
    this.r.fill(0);
    this.xpsr = XPSR_T;
    this.primask = 0;
    this.basepri = 0;
    this.faultmask = 0;
    this.control = 0;
    this.msp = 0;
    this.psp = 0;
    this.msp_ns = 0;
    this.psp_ns = 0;
    this.msplim = 0;
    this.psplim = 0;
    this.msplim_ns = 0;
    this.psplim_ns = 0;
    this.primask_ns = 0;
    this.basepri_ns = 0;
    this.faultmask_ns = 0;
    this.control_ns = 0;
    this.s.fill(0);
    this.fpscr = 0;
  }

  // --- Flag accessors ---

  get N(): boolean {
    return (this.xpsr & XPSR_N) !== 0;
  }
  set N(v: boolean) {
    if (v) this.xpsr |= XPSR_N;
    else this.xpsr &= ~XPSR_N;
  }
  get Z(): boolean {
    return (this.xpsr & XPSR_Z) !== 0;
  }
  set Z(v: boolean) {
    if (v) this.xpsr |= XPSR_Z;
    else this.xpsr &= ~XPSR_Z;
  }
  get C(): boolean {
    return (this.xpsr & XPSR_C) !== 0;
  }
  set C(v: boolean) {
    if (v) this.xpsr |= XPSR_C;
    else this.xpsr &= ~XPSR_C;
  }
  get V(): boolean {
    return (this.xpsr & XPSR_V) !== 0;
  }
  set V(v: boolean) {
    if (v) this.xpsr |= XPSR_V;
    else this.xpsr &= ~XPSR_V;
  }
  get Q(): boolean {
    return (this.xpsr & XPSR_Q) !== 0;
  }
  /** Q is sticky — once set it stays set until explicitly cleared via MSR. */
  setQ() {
    this.xpsr |= XPSR_Q;
  }
  clearQ() {
    this.xpsr &= ~XPSR_Q;
  }

  /** Read GE[3:0] flags from xPSR[19:16]. */
  get GE(): number {
    return (this.xpsr >>> XPSR_GE_SHIFT) & 0xf;
  }
  /** Write GE[3:0] flags into xPSR[19:16]. */
  set GE(value: number) {
    this.xpsr = (this.xpsr & ~XPSR_GE_MASK) | ((value & 0xf) << XPSR_GE_SHIFT);
  }

  /** Set N and Z flags from a 32-bit unsigned result. */
  setNZ(result: number) {
    this.N = (result & 0x80000000) !== 0;
    this.Z = result >>> 0 === 0;
  }
  /** Set all four NZCV flags. */
  setNZCV(n: boolean, z: boolean, c: boolean, v: boolean) {
    this.N = n;
    this.Z = z;
    this.C = c;
    this.V = v;
  }

  /** Read IT block state as a single byte (cond[7:4]:mask[3:0]). 0 = not in IT block. */
  get itState(): number {
    return ((this.xpsr >>> 19) & 0xc0) | ((this.xpsr >>> 10) & 0x3f);
  }
  /** Write IT block state from a single byte. */
  set itState(value: number) {
    this.xpsr = (this.xpsr & ~XPSR_IT_MASK) | ((value & 0xc0) << 19) | ((value & 0x3f) << 10);
  }

  /** IPSR field — exception number (0 = Thread mode). */
  get ipsr(): number {
    return this.xpsr & XPSR_IPSR_MASK;
  }
  /** True if the processor is in Handler mode (IPSR != 0). */
  inHandlerMode(): boolean {
    return this.ipsr !== 0;
  }

  // --- Named register accessors ---

  get sp(): number {
    return this.r[13];
  }
  set sp(value: number) {
    this.r[13] = value >>> 0;
  }
  get lr(): number {
    return this.r[14];
  }
  set lr(value: number) {
    this.r[14] = value >>> 0;
  }
  get pc(): number {
    return this.r[15];
  }
  set pc(value: number) {
    this.r[15] = value >>> 0;
  }

  /**
   * Returns true if the active SP is PSP (Thread mode + CONTROL.SPSEL=1).
   * Handler mode always uses MSP regardless of SPSEL.
   */
  activeSpIsPsp(): boolean {
    return !this.inHandlerMode() && (this.control & 0x2) !== 0;
  }

  /**
   * Sync R13 to the appropriate banked SP (MSP or PSP) before switching.
   * Plain instructions (PUSH/POP/SUB SP) write r[13] directly without
   * touching msp/psp; sync before any mode or SPSEL change.
   */
  syncSpToBanked() {
    if (this.activeSpIsPsp()) {
      this.psp = this.r[13];
    } else {
      this.msp = this.r[13];
    }
  }

  /** Sync R13 from the appropriate banked SP after switching. */
  syncSpFromBanked() {
    this.r[13] = this.activeSpIsPsp() ? this.psp : this.msp;
  }
}
