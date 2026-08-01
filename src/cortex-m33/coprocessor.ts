/**
 * RP2350 Cortex-M33 coprocessors: CP0 GPIOC, CP4/5 DCP, CP7 RCP.
 * See RP2350 datasheet §3.6.
 */
import { CortexM33Core, Fault } from './core';
import { M33CoreState } from '../peripherals/ppb_rp2350';
import { floatToBits, bitsToFloat } from './execute-fpu';
import { Float64 } from '../utils/types';

const PIN_MASK = 0x3fffffff; // 30 GPIO pins.

/** Coprocessor dispatch entry point. */
export function coprocessorExecute(core: CortexM33Core, hw0: number, hw1: number): number {
  const coproc = (hw1 >>> 8) & 0xf;
  // CPACR enable check: 2 bits per coprocessor; access=0 → NOCP UsageFault.
  // (The FPU/CP10-11 path has its own check inside fpuExecute.)
  const access = (core.ppb().cpacr >>> (coproc * 2)) & 0x3;
  if (access === 0) {
    core.ppb().cfsr |= 1 << 21; // NOCP
    core.pendingFault = 0; // Fault.UsageFault
    return -1;
  }
  switch (coproc) {
    case 0:
      return cp0Gpioc(core, hw0, hw1);
    case 4:
    case 5:
      return cp45Dcp(core, hw0, hw1);
    case 7:
      return cp7Rcp(core, hw0, hw1);
    default:
      return -1;
  }
}

/** Check if the instruction is MCR/MRC (vs CDP). The T1 encoding has
 * hw0[15:12]=0xE; the T2 (unconditional) encoding has hw0[15:12]=0xF. */
function isMrcMcr(hw0: number, hw1: number): boolean {
  const top = (hw0 >>> 12) & 0xf;
  return (top === 0xe || top === 0xf) && (hw1 & 0x10) !== 0;
}

/**
 * Write an MRC (coprocessor → ARM register) result. Per ARMv8-M, when Rt=15
 * (PC / APSR_nzcv) the transfer targets the condition flags: only
 * result[31:28] are written to N/Z/C/V and the PC is left unchanged. This is
 * the encoding capstone prints as `mrc pN, ..., apsr_nzcv, ...` and is used
 * by the SDK's double-precision routines (e.g. `mrc2 p4` to read DCP status
 * into the flags). Writing the value straight to r[15] instead corrupts the
 * PC and jumps to address 0.
 */
function writeMrcResult(core: CortexM33Core, Rt: number, value: number) {
  const v = value >>> 0;
  if (Rt === 15) {
    core.regs.xpsr = (core.regs.xpsr & 0x0fffffff) | (v & 0xf0000000);
  } else {
    core.regs.r[Rt] = v;
  }
}

// ============================================================================
// CP0 — GPIO Coprocessor (GPIOC)
// ============================================================================

function cp0Gpioc(core: CortexM33Core, hw0: number, hw1: number): number {
  if (!isMrcMcr(hw0, hw1)) return 1; // CDP → NOP

  const opc1 = (hw0 >>> 5) & 0x7;
  const CRn = hw0 & 0xf;
  const opc2 = (hw1 >>> 5) & 0x7;
  const CRm = hw1 & 0xf;
  const Rt = (hw1 >>> 12) & 0xf;
  const isRead = ((hw0 >>> 4) & 1) !== 0; // L bit: 1=MRC (read), 0=MCR (write)
  const regs = core.regs;

  // Bank select: 0=LO OUT, 1=LO OE, 2=LO IN, 4=HI OUT, 5=HI OE, 6=HI IN.
  const isInput = opc1 === 2 || opc1 === 6;
  const isOe = opc1 === 1 || opc1 === 5;
  const isHi = opc1 >= 4;
  void isHi; // HI bank is RAZ/WI on RP2350.

  const sio = core.chip.sio;

  // SIO GPIO register offsets (RP2350 layout — differs from RP2040).
  const GPIO_OUT = 0x010;
  const GPIO_OUT_SET = 0x018;
  const GPIO_OUT_CLR = 0x020;
  const GPIO_OUT_XOR = 0x028;
  const GPIO_OE = 0x030;
  const GPIO_OE_SET = 0x038;
  const GPIO_OE_CLR = 0x040;
  const GPIO_OE_XOR = 0x048;
  const GPIO_IN = 0x004;

  const baseOffset = isInput ? GPIO_IN : isOe ? GPIO_OE : GPIO_OUT;

  const isBulk = CRn === 0 && CRm === 0;
  if (isBulk) {
    if (isRead) {
      if (isInput) {
        writeMrcResult(core, Rt, sio.readUint32(GPIO_IN, core.coreIndex) & PIN_MASK);
      } else if (!isHi) {
        writeMrcResult(core, Rt, sio.readUint32(baseOffset, core.coreIndex) & PIN_MASK);
      } else {
        writeMrcResult(core, Rt, 0); // HI bank RAZ
      }
    } else {
      const val = regs.r[Rt] & PIN_MASK;
      if (!isInput && !isHi) {
        switch (opc2) {
          case 0:
            sio.writeUint32(baseOffset, val, core.coreIndex);
            break;
          case 1:
            sio.writeUint32(isOe ? GPIO_OE_SET : GPIO_OUT_SET, val, core.coreIndex);
            break;
          case 2:
            sio.writeUint32(isOe ? GPIO_OE_CLR : GPIO_OUT_CLR, val, core.coreIndex);
            break;
          case 3:
            sio.writeUint32(isOe ? GPIO_OE_XOR : GPIO_OUT_XOR, val, core.coreIndex);
            break;
        }
      }
    }
  } else {
    // Per-bit operation.
    const pin = (CRn << 4) | CRm;
    if (pin >= 30) {
      if (isRead) writeMrcResult(core, Rt, 0);
      return 1;
    }
    const bitMask = 1 << pin;
    if (isRead) {
      if (isInput) {
        writeMrcResult(core, Rt, (sio.readUint32(GPIO_IN, core.coreIndex) >> pin) & 1);
      } else {
        writeMrcResult(core, Rt, (sio.readUint32(baseOffset, core.coreIndex) >> pin) & 1);
      }
    } else {
      if (!isInput && !isHi) {
        switch (opc2) {
          case 4:
            // Per-bit "put": Rt[0]=1 → set only this pin; Rt[0]=0 → clear only
            // this pin. Must NOT do a bulk write (which zeroes every other pin).
            if (regs.r[Rt] & 1) {
              sio.writeUint32(isOe ? GPIO_OE_SET : GPIO_OUT_SET, bitMask, core.coreIndex);
            } else {
              sio.writeUint32(isOe ? GPIO_OE_CLR : GPIO_OUT_CLR, bitMask, core.coreIndex);
            }
            break;
          case 5:
            sio.writeUint32(isOe ? GPIO_OE_SET : GPIO_OUT_SET, bitMask, core.coreIndex);
            break;
          case 6:
            sio.writeUint32(isOe ? GPIO_OE_CLR : GPIO_OUT_CLR, bitMask, core.coreIndex);
            break;
          case 7:
            sio.writeUint32(isOe ? GPIO_OE_XOR : GPIO_OUT_XOR, bitMask, core.coreIndex);
            break;
        }
      }
    }
  }
  return 1;
}

// ============================================================================
// CP4/CP5 — Double-Precision Coprocessor (DCP)
// ============================================================================

// Saturating f64→i32 cast: NaN→0, out-of-range→MAX/MIN, in-range→truncation
// toward zero.
function f64ToI32Sat(d: Float64): number {
  if (isNaN(d)) return 0;
  if (d >= 2147483647) return 0x7fffffff;
  if (d <= -2147483648) return -2147483648;
  return Math.trunc(d) | 0;
}

// Saturating f64→u32 cast: NaN→0, negatives→0, out-of-range→MAX, in-range→
// truncation toward zero.
function f64ToU32Sat(d: Float64): number {
  if (isNaN(d) || d < 0) return 0;
  if (d >= 4294967296) return 0xffffffff;
  return Math.trunc(d) >>> 0;
}

// Reinterprets an f64 as two uint32 halves (low word first) via a shared backing
// buffer (same idiom as execute-fpu.ts's f32/u32BitsScratch). Module-scope: cts2c
// replaces readDouble/writeDouble with hand-written C bodies, so this only runs
// under Node and needs no per-instance state.
const f64BitsScratch = new Float64Array(1);
const f64WordsScratch = new Uint32Array(f64BitsScratch.buffer);
function readDouble(st: M33CoreState, idx: number): Float64 {
  f64WordsScratch[0] = st.dcpHalves[idx * 2] >>> 0;
  f64WordsScratch[1] = st.dcpHalves[idx * 2 + 1] >>> 0;
  return f64BitsScratch[0];
}
function writeDouble(st: M33CoreState, idx: number, val: Float64) {
  f64BitsScratch[0] = val;
  st.dcpHalves[idx * 2] = f64WordsScratch[0];
  st.dcpHalves[idx * 2 + 1] = f64WordsScratch[1];
}

function cp45Dcp(core: CortexM33Core, hw0: number, hw1: number): number {
  const st = core.ppb();

  if (isMrcMcr(hw0, hw1)) {
    // MCR/MRC transfer.
    const opc1 = (hw0 >>> 5) & 0x7;
    if (opc1 !== 0) return 1; // NOP for non-zero opc1
    const opc2 = (hw1 >>> 5) & 0x7;
    const CRm = hw1 & 0xf;
    const Rt = (hw1 >>> 12) & 0xf;
    const isRead = ((hw0 >>> 4) & 1) !== 0;
    const halfIdx = (CRm & 0x7) * 2 + (opc2 & 1);
    if (isRead) {
      writeMrcResult(core, Rt, st.dcpHalves[halfIdx] >>> 0);
    } else {
      st.dcpHalves[halfIdx] = core.regs.r[Rt] >>> 0;
    }
    return 1;
  }

  // CDP fields
  //   opc1=(hw0>>4)&0xf, CRn=hw0&0x7 (source #1)
  //   CRd=(hw1>>12)&0x7 (destination), opc2=(hw1>>5)&0x7, CRm=hw1&0x7 (source #2)
  const opc1 = (hw0 >>> 4) & 0xf;
  const opc2 = (hw1 >>> 5) & 0x7;
  const Rd = (hw1 >>> 12) & 0x7;
  const Rn = hw0 & 0x7;
  const Rm = hw1 & 0x7;

  switch (opc1) {
    case 0: {
      // Arithmetic
      const a = readDouble(st, Rn);
      const b = readDouble(st, Rm);
      let result: number;
      switch (opc2) {
        case 0:
          result = a + b;
          break;
        case 1:
          result = a - b;
          break;
        case 2:
          result = a * b;
          break;
        case 3:
          // Native f64 division: finite/0 = ±Inf, 0/0 = NaN. No special-case.
          result = a / b;
          break;
        case 4:
          result = a < 0 ? NaN : Math.sqrt(a);
          break; // dsqrt (unary, uses Rn)
        default:
          return 1;
      }
      writeDouble(st, Rd, result);
      updateDcpStatus(st, result);
      return opc2 === 3 ? 18 : opc2 === 4 ? 28 : opc2 === 2 ? 5 : 4;
    }
    case 1: {
      // Compares
      const a = readDouble(st, Rn);
      const b = readDouble(st, Rm);
      let eq = false;
      switch (opc2) {
        case 0:
          eq = a === b;
          break;
        case 1:
          eq = a < b;
          break;
        case 2:
          eq = a <= b;
          break;
        case 3:
          eq = a > b;
          break;
        case 4:
          eq = a >= b;
          break;
        default:
          return 1;
      }
      st.dcpStatus = eq ? 1 : 0;
      return 4;
    }
    case 2: {
      // Conversions. Each updates the status register.
      switch (opc2) {
        case 0: {
          // i2d: half A of CRn holds an i32.
          const r = st.dcpHalves[Rn * 2] | 0;
          writeDouble(st, Rd, r);
          updateDcpStatus(st, r);
          return 4;
        }
        case 1: {
          // u2d: half A of CRn holds a u32.
          const r = st.dcpHalves[Rn * 2] >>> 0;
          writeDouble(st, Rd, r);
          updateDcpStatus(st, r);
          return 4;
        }
        case 2: {
          // d2i: saturating cast, not JS modular wrap (>>> 0 would silently wrap).
          const d = readDouble(st, Rn);
          st.dcpHalves[Rd * 2] = f64ToI32Sat(d) >>> 0;
          st.dcpHalves[Rd * 2 + 1] = 0;
          updateDcpStatus(st, d);
          return 4;
        }
        case 3: {
          // d2u: saturating cast.
          const d = readDouble(st, Rn);
          st.dcpHalves[Rd * 2] = f64ToU32Sat(d);
          st.dcpHalves[Rd * 2 + 1] = 0;
          updateDcpStatus(st, d);
          return 4;
        }
        case 4: {
          // d2f: f64 → f32 in half A (half B cleared). Math.fround rounds to float32
          // precision, then floatToBits reinterprets the bits — keeping all
          // scratch-field access inside the helpers that cts2c replaces with
          // hand-written C bodies.
          const d = readDouble(st, Rn);
          const f = Math.fround(d);
          const f32bits = floatToBits(f);
          st.dcpHalves[Rd * 2] = f32bits;
          st.dcpHalves[Rd * 2 + 1] = 0;
          updateDcpStatus(st, f);
          return 4;
        }
        case 5: {
          // f2d: f32 in half A of CRn → f64 in CRd.
          const r = bitsToFloat(st.dcpHalves[Rn * 2]);
          writeDouble(st, Rd, r);
          updateDcpStatus(st, r);
          return 4;
        }
        default:
          return 1;
      }
    }
    case 3: {
      // Status
      if (opc2 === 0) {
        // dcpstat_get
        st.dcpHalves[Rd * 2] = st.dcpStatus;
        st.dcpHalves[Rd * 2 + 1] = 0;
      } else if (opc2 === 1) {
        // dcpstat_clr
        st.dcpStatus = 0;
      }
      return 1;
    }
    default:
      return 1;
  }
}

// Sign-bit check: true for -0.0 and negative NaN too, where JS `val < 0`
// returns false. Same f64BitsScratch/f64WordsScratch bit-reinterpretation technique as
// readDouble/writeDouble above (see their comment) — module-scope for the same reason.
function isSignNegative(val: Float64): boolean {
  f64BitsScratch[0] = val;
  return (f64WordsScratch[1] & 0x80000000) !== 0;
}

function updateDcpStatus(st: M33CoreState, val: Float64) {
  let s = 0;
  if (val === 0) s |= 1; // includes +0 and -0
  if (isSignNegative(val)) s |= 2;
  if (!isNaN(val) && !isFinite(val)) s |= 4; // infinity only (excludes NaN)
  if (isNaN(val)) s |= 8;
  st.dcpStatus = s;
}

// ============================================================================
// CP7 — Redundancy Coprocessor (RCP)
// ============================================================================

function cp7Rcp(core: CortexM33Core, hw0: number, hw1: number): number {
  const st = core.ppb();
  const hw0Hi = (hw0 >>> 8) & 0xff;
  const isMcrrMrrc = hw0Hi === 0xec || hw0Hi === 0xfc;

  if (isMcrrMrrc) {
    return cp7McrrMrrc(core, hw0, hw1);
  }
  // MCR/MRC/CDP family (0xEE or 0xFE prefix).
  if (!isMrcMcr(hw0, hw1)) {
    // CDP.
    const opc1 = (hw0 >>> 4) & 0xf;
    const opc2 = (hw1 >>> 5) & 0x7;
    if (opc1 === 0 && opc2 === 1) {
      // rcp_panic → NMI.
      core.pendingFault = 3; // Fault.Nmi
    }
    return 1;
  }

  const opc1 = (hw0 >>> 5) & 0x7;
  const opc2 = (hw1 >>> 5) & 0x7;
  const CRn = hw0 & 0xf;
  const CRm = hw1 & 0xf;
  const Rt = (hw1 >>> 12) & 0xf;
  const isRead = ((hw0 >>> 4) & 1) !== 0;
  const imm = (CRn << 4) | CRm;
  const regs = core.regs;

  switch (opc1) {
    case 0:
      if (opc2 === 1) {
        if (isRead) {
          // rcp_canary_get: R[t] = salt ^ 0xDEADBEEF (or 0 ^ 0xDEADBEEF if invalid).
          const salt = st.rcpSaltValid ? st.rcpSalt : 0;
          writeMrcResult(core, Rt, (salt ^ 0xdeadbeef) >>> 0);
        } else {
          // rcp_canary_check: assert R[t] == expected.
          const salt = st.rcpSaltValid ? st.rcpSalt : 0;
          if (regs.r[Rt] !== (salt ^ 0xdeadbeef) >>> 0) {
            core.pendingFault = 3; // Fault.Nmi
          }
        }
      }
      return 1;
    case 1:
      if (isRead && Rt === 15 && opc2 === 0 && CRn === 0 && CRm === 0) {
        // rcp_canary_status: N = salt_valid (1=valid), Z/C/V cleared.
        // Reference: xpsr = (xpsr & 0x0FFFFFFF) | (salt_valid ? N : 0).
        const n = st.rcpSaltValid ? 0x80000000 : 0;
        regs.xpsr = (regs.xpsr & 0x0fffffff) | n;
      } else if (!isRead && opc2 === 0 && CRn === 0 && CRm === 0) {
        // rcp_bvalid: assert R[t] is a valid boolean (0xa500a500 or 0x00c300c3).
        const v = regs.r[Rt] >>> 0;
        if (v !== 0xa500a500 && v !== 0x00c300c3) core.pendingFault = 3;
      }
      return 1;
    case 2:
      if (!isRead && opc2 === 0 && CRn === 0 && CRm === 0) {
        // rcp_btrue: assert R[t] == 0xa500a500.
        if (regs.r[Rt] >>> 0 !== 0xa500a500) core.pendingFault = 3;
      }
      return 1;
    case 3:
      if (!isRead && opc2 === 1 && CRn === 0 && CRm === 0) {
        // rcp_bfalse: assert R[t] == 0x00c300c3.
        if (regs.r[Rt] >>> 0 !== 0x00c300c3) core.pendingFault = 3;
      }
      return 1;
    case 4:
      if (!isRead && opc2 === 0) {
        // rcp_count_init.
        st.rcpCount = imm;
      }
      return 1;
    case 5:
      if (!isRead && opc2 === 1) {
        // rcp_count_check: assert counter == imm, then increment.
        if (st.rcpCount !== imm) {
          core.pendingFault = 3;
        } else {
          st.rcpCount = (st.rcpCount + 1) & 0xff;
        }
      }
      return 1;
    default:
      return 1; // NOP for unimplemented ops.
  }
}

function cp7McrrMrrc(core: CortexM33Core, hw0: number, hw1: number): number {
  // L bit (hw0[4]): 0=MCRR (write), 1=MRRC (read). MRRC2 from CP7 is a NOP
  // per the reference (coprocessor.rs:676-679) — must not trigger rcp ops.
  if ((hw0 & 0x10) !== 0) return 1;
  // opc1 is hw1[7:4], CRm is hw1[3:0], Rt is hw1[15:12], Rt2 is hw0[3:0].
  const opc1 = (hw1 >>> 4) & 0xf;
  const CRm = hw1 & 0xf;
  const Rt = (hw1 >>> 12) & 0xf;
  const Rt2 = hw0 & 0xf;
  const regs = core.regs;

  switch (opc1) {
    case 7:
      if (CRm === 0) {
        // rcp_iequal: assert R[Rt] == R[Rt2].
        if (regs.r[Rt] !== regs.r[Rt2]) {
          core.pendingFault = Fault.Nmi;
        }
      }
      return 1;
    case 8: {
      // rcp_salt_core0 (CRm=0) / rcp_salt_core1 (CRm=1). Per datasheet
      // §3.6.3.1, core 0's coprocessor port writes BOTH cores' salts during
      // early boot, so CRm selects the *target* core's salt register — not
      // the executing core. Initially the salt is invalid; rcp_salt_coreN
      // writes a 64-bit value (Rt:Rt2) and marks it valid. Writing an
      // already-valid salt is an anomaly that triggers an RCP fault (NMI).
      const states: [M33CoreState, M33CoreState] = core.chip.ppb!.coreState;
      const target = states[CRm & 1];
      if (target.rcpSaltValid) {
        core.pendingFault = Fault.Nmi;
      } else {
        // 64-bit salt; the low word (Rt) seeds the stack-canary value
        // returned by rcp_canary_get, which is all the model needs.
        target.rcpSalt = regs.r[Rt];
        target.rcpSaltValid = true;
      }
      return 1;
    }
    default:
      return 1; // NOP for unimplemented.
  }
}
