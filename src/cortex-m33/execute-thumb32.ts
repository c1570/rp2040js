/**
 * Cortex-M33 Thumb-32 instruction executor.
 *
 * Dispatch follows ARMv7-M §A5.1: the first halfword (hw0) bits [15:11]
 * identify the encoding group:
 *
 *   0b11101 (0xe8xx): load/store multiple, dual, exclusive, table branch,
 *                     data-processing (shifted register), coprocessor.
 *   0b11110 (0xf0xx-0xf7xx): data-processing (modified immediate),
 *                            data-processing (plain immediate), branches,
 *                            MSR/MRS, barriers.
 *   0b11111 (0xf8xx-0xffxx): load/store single, data-processing (register),
 *                            multiply, long multiply, divide, coprocessor.
 *
 * Reference: ARMv8-M Architecture Reference Manual §A6.3 (Thumb-32 encodings)
 */

import { CortexM33Core } from './core';
import { conditionPassed } from './conditions';
import { fpuExecute } from './execute-fpu';
import { coprocessorExecute } from './coprocessor';

/**
 * Out-parameter for thumbExpandImm/thumbExpandImmC. Same out-param pattern as
 * fpu-helpers.ts's FpResult, but for a sharper reason: a DECLARATION-form
 * destructure (`const [a, b] = f()`) compiles each variable to `f()[i]`, indexing
 * the stubbed integer return value — a null deref in the C build. Caller-owned and
 * reused across calls.
 */
export interface ImmCarry {
  value: number;
  carryOut: boolean;
}

/**
 * Out-parameter for mul64/mul64Signed's 64-bit {hi32, lo32} product. Same
 * reasoning as ImmCarry above — a `const [hi, lo] = mul64(...)` destructure
 * would crash the C build the same way.
 */
export interface Mul64Result {
  hi: number;
  lo: number;
}

/** Coprocessor dispatch: CP10/CP11 → FPU, CP0/4/5/7 → RP2350 coprocs. */
function dispatchCoprocessor(core: CortexM33Core, hw0: number, hw1: number): number {
  const coproc = (hw1 >>> 8) & 0xf;
  if (coproc === 10 || coproc === 11) {
    const result = fpuExecute(core, hw0, hw1);
    if (result < 0 && core.ppb().cfsr & (1 << 21)) {
      core.pendingFault = 0; // Fault.UsageFault (NOCP)
    }
    return result;
  }
  if (coproc === 0 || coproc === 4 || coproc === 5 || coproc === 7) {
    const result = coprocessorExecute(core, hw0, hw1);
    // Check for RCP panic/assertion → NMI.
    if (core.pendingFault === 3 && !core.regs.inHandlerMode()) {
      const f = core.pendingFault;
      core.pendingFault = null;
      core.deliverFault(f as unknown as 0);
    }
    return result < 0 ? 1 : result;
  }
  return -1;
}

/**
 * Returns true if the halfword signals the start of a 32-bit Thumb instruction.
 * Per ARMv7-M §A5.1: bits [15:13]=0b111 and bits [12:11] != 0b00.
 */
export function isThumb32(hw0: number): boolean {
  return (hw0 & 0xe000) === 0xe000 && (hw0 & 0x1800) !== 0;
}

/**
 * ThumbExpandImm: expand a 12-bit modified-immediate to a 32-bit value per
 * ARMv7-M §A6.3.2. `out` is scratch, discarded — see {@link thumbExpandImmC}.
 */
export function thumbExpandImm(imm12: number, out: ImmCarry): number {
  thumbExpandImmC(imm12, false, out);
  return out.value;
}

/**
 * ThumbExpandImm_C: like {@link thumbExpandImm} but also returns the carry-out
 * (ARMv7-M §A6.3.2) via `out.carryOut`. For the byte-replication forms
 * (imm12[11:10]=00) the carry is unchanged (`carryIn`); for the rotated form
 * the carry is bit[31] of the result.
 */
export function thumbExpandImmC(imm12: number, carryIn: boolean, out: ImmCarry): void {
  if ((imm12 & 0xc00) === 0) {
    const imm8 = imm12 & 0xff;
    let val: number;
    switch ((imm12 >>> 8) & 0x3) {
      case 0:
        val = imm8;
        break;
      case 1:
        val = (imm8 << 16) | imm8;
        break;
      case 2:
        val = (imm8 << 24) | (imm8 << 8);
        break;
      default:
        val = (imm8 << 24) | (imm8 << 16) | (imm8 << 8) | imm8;
        break;
    }
    out.value = val >>> 0;
    out.carryOut = carryIn;
    return;
  }
  const unrotated = 0x80 | (imm12 & 0x7f);
  const ror = (imm12 >>> 7) & 0x1f;
  const val = ((unrotated >>> ror) | (unrotated << (32 - ror))) >>> 0;
  out.value = val;
  out.carryOut = (val & 0x80000000) !== 0;
}

/** Sign-extend the low `bits` bits of `value` to a signed 32-bit integer. */
function signExtend(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

/** 64-bit unsigned multiply helper; writes {hi32, lo32} into `out` (see Mul64Result). */
function mul64(a: number, b: number, out: Mul64Result): void {
  // Split each 32-bit value into two 16-bit halves to avoid JS Number precision.
  const aLo = a & 0xffff;
  const aHi = a >>> 16;
  const bLo = b & 0xffff;
  const bHi = b >>> 16;
  const ll = aLo * bLo;
  const lh = aLo * bHi;
  const hl = aHi * bLo;
  const hh = aHi * bHi;
  // Combine with carry.
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  const lo = (ll & 0xffff) | (mid << 16);
  const hi = hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16);
  out.hi = hi >>> 0;
  out.lo = lo >>> 0;
}

/**
 * Signed 64-bit multiply of two 32-bit values; writes {hi32, lo32} into `out`. Computes
 * the product of the magnitudes via {@link mul64} (reusing `out` as its own scratch —
 * safe since the result is read back into locals immediately below before being
 * overwritten again) and applies two's-complement negation when exactly one input is
 * negative.
 */
function mul64Signed(a: number, b: number, out: Mul64Result): void {
  const sa = a | 0;
  const sb = b | 0;
  const negate = sa < 0 !== sb < 0;
  mul64(sa < 0 ? -sa : sa, sb < 0 ? -sb : sb, out);
  if (!negate) return;
  const hi = out.hi;
  const lo = out.lo;
  // Two's-complement negation of the 64-bit (hi:lo) pair: ~hi:~lo + 1.
  const nlo = (~lo + 1) >>> 0;
  const nhi = ((~hi >>> 0) + (lo === 0 ? 1 : 0)) >>> 0;
  out.hi = nhi;
  out.lo = nlo;
}

/**
 * Execute one Thumb-32 instruction.
 * @returns elapsed cycles, or -1 if unimplemented (caller logs + advances).
 */
export function executeThumb32(
  core: CortexM33Core,
  opcodePC: number,
  hw0: number,
  hw1: number
): number {
  const regs = core.regs;
  let deltaCycles = 1;
  const group = hw0 & 0xf800; // bits [15:11]

  // SG (Secure Gateway): hw0=0xe97f, hw1=0xe97f. Transitions to Secure state.
  if (hw0 === 0xe97f && hw1 === 0xe97f) {
    core.secure = true;
    return 1;
  }

  // TT/TTT/TTA/TTAT (Test Target): returns security attribution for an address.
  // Encoding (verified against `arm-none-eabi-as -march=armv8-m.main`):
  // hw0 = 0xe840 | Rn; hw1 = 1111 Rt(4) variant(2) 000000, i.e.
  // hw1 & 0xf03f === 0xf000 (variant bits [7:6] select TT/TTT/TTA/TTAT).
  if ((hw0 & 0xfff0) === 0xe840 && (hw1 & 0xf03f) === 0xf000) {
    const rt = (hw1 >>> 8) & 0xf;
    // Stub: we don't model per-region SAU security, so approximate "is the
    // tested address Secure" as "are we currently executing Secure" — true
    // for any non-partitioned/non-TrustZone-split image (the common case).
    // Bit 22 is the real TT result's "S" (Secure) attribute bit; that's the
    // only bit callers commonly test (e.g. the SDK's rom_func_lookup, which
    // shifts it into the sign bit to choose the ARM_SEC vs ARM_NONSEC mask).
    regs.r[rt] = core.secure ? 0x400000 : 0;
    return 1;
  }

  // Add/sub helpers with flags. Carry/overflow via 32-bit bit tricks — see
  // execute-thumb16.ts's addFlags for why the exact-sum-comparison approach
  // fails in the C build.
  const addWithFlags = (a: number, b: number): number => {
    const au = a >>> 0;
    const bu = b >>> 0;
    const r = (a + b) | 0;
    regs.N = (r & 0x80000000) !== 0;
    regs.Z = (r & 0xffffffff) === 0;
    regs.C = au > 0xffffffff - bu;
    regs.V = (~(a ^ b) & (a ^ r)) < 0;
    return r & 0xffffffff;
  };
  const subWithFlags = (a: number, b: number): number => {
    const r = (a - b) >>> 0;
    regs.N = (r & 0x80000000) !== 0;
    regs.Z = r === 0;
    regs.C = a >>> 0 >= b >>> 0;
    regs.V = ((a ^ b) & (a ^ r)) < 0;
    return r;
  };
  const writeRd = (rd: number, value: number) => {
    if (rd === 15) {
      regs.pc = (value & ~1) >>> 0;
      deltaCycles++;
    } else {
      regs.r[rd] = value >>> 0;
    }
  };

  // ===== Group 0b11110 (0xf000-0xf7ff): DP immediate + branches + MSR/MRS =====
  if (group === 0xf000) {
    // Check misc-control patterns FIRST (they have hw1[15]=1 too, so the
    // branch check by hw1[15] alone is ambiguous).
    // MRS: hw0 = 0xf3ef (exact match).
    if (hw0 === 0xf3ef) {
      const rd = (hw1 >>> 8) & 0xf;
      const sysm = hw1 & 0xff;
      const value = readSpecialRegister(core, sysm);
      if (rd !== 15) regs.r[rd] = value >>> 0;
      return 2;
    }
    // MSR: hw0[15:4] = 0xf380, hw1[15:8] = 0x88.
    if ((hw0 & 0xfff0) === 0xf380 && (hw1 & 0xff00) === 0x8800) {
      const rn = hw0 & 0xf;
      const sysm = hw1 & 0xff;
      writeSpecialRegister(core, sysm, regs.r[rn]);
      return 2;
    }
    // DSB/DMB/ISB/CLREX/NOP.W: hw0 = 0xf3bf.
    if (hw0 === 0xf3bf) {
      const op2 = (hw1 >>> 4) & 0xf;
      if (op2 <= 0x2) return 1; // NOP/YIELD/CLREX
      if (op2 >= 0x4 && op2 <= 0x6) return 2; // DSB/DMB/ISB
      return -1;
    }
    // Branches: hw1[15]=1. BL/B.W have specific hw1[15:14] patterns.
    if ((hw1 & 0x8000) !== 0) {
      return dispatchLongBranch(core, opcodePC, hw0, hw1);
    }
    // Data-processing immediate. bit[9] distinguishes modified vs plain:
    //   bit[9]=0 → modified immediate (ThumbExpandImm)
    //   bit[9]=1 → plain immediate (MOVW/MOVT/ADDW/SUBW)
    if ((hw0 & 0x200) === 0) {
      return dispatchDpModifiedImm(core, hw0, hw1);
    }
    return dispatchDpPlainImm(core, hw0, hw1);
  }

  // ===== Group 0b11101 (0xe8xx-0xefff): LDM/STM, DP shifted reg, LD/ST dual =====
  if (group === 0xe800) {
    const sub = (hw0 >>> 9) & 0x3; // hw0[10:9]
    if (sub === 0b00 && (hw0 & 0x40) === 0) {
      // Load/store multiple (LDM/STM). Distinguished from load/store dual by
      // hw0[6]=0. Fields: W=hw0[5], L(load)=hw0[4], op=P:U=hw0[8:7] (01=IA,
      // 10=DB). Rn=hw0[3:0], register list = hw1.
      const writeback = (hw0 & 0x20) !== 0;
      const isLoad = (hw0 & 0x10) !== 0;
      const op = (hw0 >>> 7) & 0x3;
      const rn = hw0 & 0xf;
      const list = hw1 & 0xffff;
      let count = 0;
      for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
      let addr: number;
      if (op === 0b01) {
        addr = regs.r[rn] >>> 0; // IA: start at Rn
      } else if (op === 0b10) {
        addr = (regs.r[rn] - 4 * count) >>> 0; // DB: start at Rn - 4*count
      } else {
        return -1; // reserved P:U
      }
      // Writeback (only when W is set and, for loads, Rn is not in the list)
      // must happen *before* the load loop below, not after — if PC is in
      // the list (i === 15), `core.bxWritePC(val)` may detect an EXC_RETURN
      // pattern and call exceptionReturn(), which reads the exception frame
      // from the *current* regs.sp (via registers.ts syncSpToBanked). For
      // the common `pop {...,pc}` = `ldm sp!, {...}` case (rn=13), that must
      // already be the fully-popped SP, not the stale pre-writeback value —
      // getting this backwards corrupts the computed frame address by the
      // size of the loaded register list, same bug as the Thumb-16 POP
      // handler in execute-thumb16.ts. `addr` (the iteration cursor) is
      // tracked separately from `regs.r[rn]`, so reordering this is safe
      // even when rn is not in the list.
      if (writeback && (!isLoad || (list & (1 << rn)) === 0)) {
        regs.r[rn] = op === 0b01 ? (regs.r[rn] + 4 * count) >>> 0 : (regs.r[rn] - 4 * count) >>> 0;
      }
      for (let i = 0; i < 16; i++) {
        if (list & (1 << i)) {
          if (isLoad) {
            const val = core.chip.readUint32(addr) >>> 0;
            if (i === 15) core.bxWritePC(val);
            else regs.r[i] = val;
          } else {
            core.chip.writeUint32(addr, regs.r[i]);
          }
          addr = (addr + 4) >>> 0;
          deltaCycles++;
        }
      }
      return deltaCycles;
    }
    if (
      sub === 0b00 &&
      (hw0 & 0x40) !== 0 &&
      (hw0 & 0x100) === 0 &&
      [0x4, 0x5, 0xc, 0xd].includes((hw0 >>> 4) & 0xf)
    ) {
      // Load/store exclusive, load-acquire/store-release (plain and
      // exclusive), and table branch (TBB/TBH) — these share hw0's "nibble2
      // clear (bit8=0)" shape with LDRD/STRD's post-indexed forms (which use
      // hw0[7:4] = 0xe/0xf instead), so they must be checked before falling
      // into the general LDRD/STRD decode below. Verified against
      // `arm-none-eabi-as -march=armv8-m.main` for all sub-forms.
      //
      // We don't model the ARM exclusive-access monitor (no real inter-core
      // contention happens within a single JS-stepped core, and we never
      // yield between a *EX load and its matching store), so LDREX*/LDAEX*
      // are treated as plain loads and STREX*/STLEX* always succeed (status
      // 0) and perform the store — CLREX is a no-op. LDA*/STL* (non-exclusive
      // acquire/release) are plain loads/stores; we don't model memory
      // ordering since execution is single-threaded and synchronous.
      const op1 = (hw0 >>> 4) & 0xf;
      const rn = hw0 & 0xf;
      const base = regs.r[rn] >>> 0;
      if (op1 === 0x5) {
        // LDREX Rt, [Rn] (plain word, imm8 fixed at 0).
        const rt = (hw1 >>> 12) & 0xf;
        regs.r[rt] = core.chip.readUint32(base) >>> 0;
        return 2;
      }
      if (op1 === 0x4) {
        // STREX Rd, Rt, [Rn] (plain word, imm8 fixed at 0). Verified against
        // `arm-none-eabi-as`: hw1[15:12]=Rt, hw1[11:8]=Rd (Rt first, despite
        // the Rd-first assembly syntax).
        const rt = (hw1 >>> 12) & 0xf;
        const rd = (hw1 >>> 8) & 0xf;
        core.chip.writeUint32(base, regs.r[rt]);
        regs.r[rd] = 0; // success
        return 2;
      }
      // op1 is 0xc (store family) or 0xd (load family / TBB-TBH).
      const rtOrRd = (hw1 >>> 12) & 0xf;
      if (op1 === 0xd && rtOrRd === 0xf) {
        // TBB/TBH: hw1 = 1111 0000 000H Rm.
        const isHalf = (hw1 & 0x10) !== 0;
        const rm = hw1 & 0xf;
        const rmVal = regs.r[rm] >>> 0;
        const tblAddr = isHalf ? (base + (rmVal << 1)) >>> 0 : (base + rmVal) >>> 0;
        const halfOffset = isHalf
          ? core.readUint16Unaligned(tblAddr)
          : core.chip.readUint8(tblAddr);
        core.bxWritePC((opcodePC + 4 + halfOffset * 2) >>> 0);
        return 3;
      }
      const subOp = (hw1 >>> 4) & 0xf;
      if (op1 === 0xd) {
        // Load family: LDREXB/H (4/5), LDAB/H/word (8/9/a), LDAEXB/H/word (c/d/e).
        const rt = rtOrRd;
        switch (subOp) {
          case 0x4:
          case 0xc:
            regs.r[rt] = core.chip.readUint8(base);
            break;
          case 0x5:
          case 0xd:
            regs.r[rt] = core.chip.readUint16(base) >>> 0;
            break;
          default:
            // 0x8/0x9 aren't real ops here (LDAB/LDAH use 8/9 too — but those
            // are byte/half, handled above by matching hw0's op1 instead);
            // 0xa/0xe: word-sized LDA/LDAEX.
            regs.r[rt] = core.chip.readUint32(base) >>> 0;
        }
        return 2;
      }
      // op1 === 0xc: store family. EX variants (op 4/5/c/d/e) carry Rt in
      // hw1[15:12] and a status Rd in hw1[3:0]; plain release stores (op
      // 8/9/a) have no Rd — Rt is hw1[15:12] and hw1[3:0] is fixed/unused.
      // (Verified against `arm-none-eabi-as`: same Rt-first field order as
      // plain STREX above, despite the Rd-first assembly syntax for the EX
      // forms.)
      const isExStore =
        subOp === 0x4 || subOp === 0x5 || subOp === 0xc || subOp === 0xd || subOp === 0xe;
      const rt = rtOrRd;
      switch (subOp) {
        case 0x4:
        case 0x8:
          core.chip.writeUint8(base, regs.r[rt] & 0xff);
          break;
        case 0x5:
        case 0x9:
          core.chip.writeUint16(base, regs.r[rt] & 0xffff);
          break;
        default:
          core.chip.writeUint32(base, regs.r[rt]);
      }
      if (isExStore) regs.r[hw1 & 0xf] = 0; // status: success
      return 2;
    }
    if (sub === 0b00 && (hw0 & 0x40) !== 0) {
      // Load/store dual (LDRD/STRD). P=hw0[8], U=hw0[7], W=hw0[5], L=hw0[4].
      // The immediate offset is imm8<<2 (scaled by 4); U selects add/subtract
      // (not the imm8 MSB). P/W select the indexing mode.
      const isStore = (hw0 & 0x10) === 0;
      const p = (hw0 & 0x100) !== 0;
      const u = (hw0 & 0x80) !== 0;
      const w = (hw0 & 0x20) !== 0;
      const rn = hw0 & 0xf;
      const rt = (hw1 >>> 12) & 0xf;
      const rt2 = (hw1 >>> 8) & 0xf;
      const imm8 = hw1 & 0xff;
      const offset = imm8 << 2;
      const base = rn === 15 ? (opcodePC + 4) & ~3 : regs.r[rn];
      const offsetAddr = u ? (base + offset) >>> 0 : (base - offset) >>> 0;
      // P=1 → pre-indexed (access at offsetAddr); P=0 → post-indexed (access at base).
      const addr = p ? offsetAddr : base;
      if (isStore) {
        core.chip.writeUint32(addr, regs.r[rt]);
        core.chip.writeUint32((addr + 4) >>> 0, regs.r[rt2]);
      } else {
        regs.r[rt] = core.chip.readUint32(addr) >>> 0;
        regs.r[rt2] = core.chip.readUint32((addr + 4) >>> 0) >>> 0;
      }
      // Writeback: W=1 writes offsetAddr back to Rn (pre-indexed-writeback or
      // post-indexed, which encodes P=0,W=1).
      if (w && rn !== 15) {
        regs.r[rn] = offsetAddr;
      }
      return 3;
    }
    if (sub === 0b01) {
      // Data-processing (shifted register).
      return dispatchDpShiftedReg(core, hw0, hw1);
    }
    if (sub === 0b10) {
      // Load/store dual / exclusive / table branch / coprocessor load-store.
      const coproc = (hw1 >>> 8) & 0xf;
      if (
        coproc === 10 ||
        coproc === 11 ||
        coproc === 0 ||
        coproc === 4 ||
        coproc === 5 ||
        coproc === 7
      ) {
        return dispatchCoprocessor(core, hw0, hw1);
      }
      return -1;
    }
    // sub === 0b11: coprocessor (FPU + RP2350 coprocs).
    return dispatchCoprocessor(core, hw0, hw1);
  }

  // ===== Group 0b11111 (0xf8xx-0xffff): LD/ST single, DP register, mult, div =====
  if (group === 0xf800) {
    // Dispatch on hw0[15:8] (top byte). Common prefixes:
    //   0xf8 → Load/store single (LDR.W, STR.W, etc.)
    //   0xf9 → Load/store single (literal / different forms)
    //   0xfa → Data-processing (register)
    //   0xfb → Multiply, multiply-accumulate, divide, long multiply
    const prefix = hw0 & 0xff00;
    if (prefix === 0xf800 || prefix === 0xf900) {
      return dispatchLoadStoreSingle(core, opcodePC, hw0, hw1);
    }
    if (prefix === 0xfa00) {
      return dispatchDpRegister(core, hw0, hw1);
    }
    if (prefix === 0xfb00) {
      return dispatchMultiply(core, hw0, hw1);
    }
    // 0xee/0xef/0xfe/0xff → coprocessor (FPU + RP2350 coprocs). The 0xfe/0xff
    // prefix is the unconditional (T2) coprocessor encoding; 0xee/0xef is T1.
    if (prefix === 0xee00 || prefix === 0xef00 || prefix === 0xfe00 || prefix === 0xff00) {
      return dispatchCoprocessor(core, hw0, hw1);
    }
    // 0xec/0xed/0xfc/0xfd → coprocessor load/store (and MCRR/MRRC).
    if (prefix === 0xec00 || prefix === 0xed00 || prefix === 0xfc00 || prefix === 0xfd00) {
      return dispatchCoprocessor(core, hw0, hw1);
    }
    return -1;
  }

  return -1;
}

// Write a DP-instruction result to Rd, routing through bxWritePC (masks bit0
// and detects EXC_RETURN) when Rd=15 instead of a raw register write. Per
// ARMv8-M ARM, DP instructions that write PC use ALUWritePC/BranchWritePC,
// e.g. the jump-table idiom `ADD.W pc, pc, r0, lsl #2` — a raw write could
// leave bit0 set if the computed value happened to be odd. PC is read back
// unmasked by other instructions taking it as an operand (e.g. TBB/TBH's
// `base = regs.r[rn]` when Rn=PC), so a stray odd write here would silently
// corrupt every subsequent PC-relative table/address computation until the
// next branch — ordinary instruction fetch masks bit0 on every fetch, so the
// corruption wouldn't otherwise crash or show up there.
function writeDpResult(core: CortexM33Core, rd: number, value: number): void {
  if (rd === 15) {
    core.bxWritePC(value >>> 0);
  } else {
    core.regs.r[rd] = value >>> 0;
  }
}

// ---- Data-processing (modified immediate) ----
function dispatchDpModifiedImm(core: CortexM33Core, hw0: number, hw1: number): number {
  const regs = core.regs;
  // op = hw0[8:5], S = hw0[4], Rn = hw0[3:0]. The 12-bit ThumbExpandImm input is
  // i:imm3:imm8 with i at hw0[10], imm3 at hw1[14:12], imm8 at hw1[7:0].
  const op = (hw0 >>> 5) & 0xf;
  const sBit = (hw0 & 0x10) !== 0;
  const rn = hw0 & 0xf;
  const rd = (hw1 >>> 8) & 0xf;
  const i = (hw0 >>> 10) & 0x1;
  const imm3 = (hw1 >>> 12) & 0x7;
  const imm8 = hw1 & 0xff;
  const imm12 = (i << 11) | (imm3 << 8) | imm8;
  thumbExpandImmC(imm12, regs.C, core.immCarryScratch);
  const imm = core.immCarryScratch.value;
  const teCarry = core.immCarryScratch.carryOut;
  const rnVal = rn === 15 ? regs.pc : regs.r[rn];

  // Logical ops set N/Z from the result and C from the ThumbExpandImm carry-out
  // when S=1.
  const writeLogical = (result: number, isTest: boolean) => {
    if (!isTest) writeDpResult(core, rd, result);
    if (sBit) {
      regs.setNZ(result);
      regs.C = teCarry;
    }
  };

  switch (op) {
    case 0b0000: // AND / TST (S=1, Rd=15)
      writeLogical((rnVal & imm) >>> 0, sBit && rd === 15);
      return 1;
    case 0b0001: // BIC
      writeLogical((rnVal & ~imm) >>> 0, false);
      return 1;
    case 0b0010: // ORR / MOV (Rn=15)
      writeLogical(rn === 15 ? imm >>> 0 : (rnVal | imm) >>> 0, false);
      return 1;
    case 0b0011: // ORN / MVN (Rn=15)
      writeLogical(rn === 15 ? ~imm >>> 0 : (rnVal | ~imm) >>> 0, false);
      return 1;
    case 0b0100: // EOR / TEQ (S=1, Rd=15)
      writeLogical((rnVal ^ imm) >>> 0, sBit && rd === 15);
      return 1;
    case 0b1000: {
      // ADD / CMN (S=1, Rd=15 → flags only)
      const result = addSubFlags(core, rnVal, imm, true, 0, sBit);
      if (!(sBit && rd === 15)) writeDpResult(core, rd, result);
      return 1;
    }
    case 0b1010: // ADC
      writeDpResult(core, rd, addSubFlags(core, rnVal, imm, true, regs.C ? 1 : 0, sBit));
      return 1;
    case 0b1011: // SBC
      writeDpResult(core, rd, addSubFlags(core, rnVal, imm + (regs.C ? 0 : 1), false, 0, sBit));
      return 1;
    case 0b1101: {
      // SUB / CMP (S=1, Rd=15 → flags only)
      const result = addSubFlags(core, rnVal, imm, false, 0, sBit);
      if (!(sBit && rd === 15)) writeDpResult(core, rd, result);
      return 1;
    }
    case 0b1110: // RSB
      writeDpResult(core, rd, addSubFlags(core, imm, rnVal, false, 0, sBit));
      return 1;
    default:
      return -1;
  }
}

// ---- Data-processing (plain immediate): MOVW, MOVT, ADDW, SUBW ----
function dispatchDpPlainImm(core: CortexM33Core, hw0: number, hw1: number): number {
  const regs = core.regs;
  // bits[8:4] of hw0 (= bits[24:20] of full word) is the op field.
  const opField = (hw0 >>> 4) & 0x1f;
  const i = (hw0 >>> 10) & 0x1;
  const rn = hw0 & 0xf;
  const rd = (hw1 >>> 8) & 0xf;
  const imm3 = (hw1 >>> 12) & 0x7;
  const imm8 = hw1 & 0xff;

  // MOVW: opField = 00100 (4) exactly. MOVT: opField = 01100 (12) exactly.
  // (These must be *exact* matches, not just "low 3 bits == 0b100" — SBFX
  // (opField=20=0b10100) and UBFX (opField=28=0b11100) also have low 3 bits
  // == 0b100 and were being misdecoded as MOVT by a too-loose check, silently
  // corrupting Rd's upper 16 bits instead of computing a bitfield extract.
  // Verified all opField values below against `arm-none-eabi-as
  // -march=armv8-m.main`.)
  if (opField === 0b00100 || opField === 0b01100) {
    const isMovt = opField === 0b01100;
    const imm4 = rn;
    const imm16 = ((i << 11) | (imm4 << 12) | (imm3 << 8) | imm8) & 0xffff;
    if (isMovt) {
      regs.r[rd] = ((regs.r[rd] & 0xffff) | (imm16 << 16)) >>> 0;
    } else {
      regs.r[rd] = imm16;
    }
    return 1;
  }
  // ADDW: opField = 00000 (0)
  if (opField === 0b00000) {
    const imm12 = (i << 11) | (imm3 << 8) | imm8;
    const base = rn === 15 ? regs.pc : regs.r[rn];
    regs.r[rd] = (base + imm12) >>> 0;
    return 1;
  }
  // SUBW: opField = 01010 (10)
  if (opField === 0b01010) {
    const imm12 = (i << 11) | (imm3 << 8) | imm8;
    const base = rn === 15 ? regs.pc : regs.r[rn];
    regs.r[rd] = (base - imm12) >>> 0;
    return 1;
  }
  // SBFX (opField=20)/UBFX (opField=28): Rd = bitfield extract from Rn,
  // starting at lsb = (imm3<<2)|imm2, for `widthMinus1+1` bits. hw1 layout:
  // imm3(3, bits[14:12]) Rd(4, bits[11:8]) imm2(2, bits[7:6]) widthMinus1(5,
  // bits[4:0]).
  if (opField === 0b10100 || opField === 0b11100) {
    const isUnsigned = opField === 0b11100;
    const imm2 = (hw1 >>> 6) & 0x3;
    const widthMinus1 = hw1 & 0x1f;
    const lsb = (imm3 << 2) | imm2;
    const width = widthMinus1 + 1;
    const value = regs.r[rn];
    const extracted = width >= 32 ? value : (value >>> lsb) & ((1 << width) - 1);
    regs.r[rd] = isUnsigned
      ? extracted >>> 0
      : width >= 32
      ? extracted
      : ((extracted << (32 - width)) >> (32 - width)) >>> 0;
    return 1;
  }
  // BFI (Rn != 1111) / BFC (Rn == 1111): Rd[msb:lsb] = Rn[width-1:0] (BFI) or
  // 0 (BFC); other bits of Rd unchanged. hw1 layout: imm3(3, bits[14:12])
  // Rd(4, bits[11:8]) imm2(2, bits[7:6]) msb(5, bits[4:0]).
  if (opField === 0b10110) {
    const imm2 = (hw1 >>> 6) & 0x3;
    const msb = hw1 & 0x1f;
    const lsb = (imm3 << 2) | imm2;
    if (msb >= lsb) {
      const width = msb - lsb + 1;
      const mask = (width >= 32 ? 0xffffffff : ((1 << width) - 1) << lsb) >>> 0;
      const insertVal = rn === 15 ? 0 : (regs.r[rn] << lsb) & mask;
      regs.r[rd] = ((regs.r[rd] & ~mask) | insertVal) >>> 0;
    }
    return 1;
  }
  // SSAT / USAT: signed/unsigned saturate. Field layout (verified against
  // `arm-none-eabi-as`):
  //   Rm = hw0[3:0], Rd = hw1[11:8], sat_imm = hw1[4:0] (sat width = sat_imm+1)
  //   shift = (hw1[14:12]<<2)|hw1[7:6]; hw0[5]=1 → ASR, 0 → LSL
  //   SSAT: opField=16(LSL)/18(ASR); USAT: opField=24(LSL)/26(ASR) [hw0[7] set]
  if (opField === 0b10000 || opField === 0b10010 || opField === 0b11000 || opField === 0b11010) {
    const isUnsigned = (opField & 0b01000) !== 0;
    const isAsr = (opField & 0b00010) !== 0;
    const rmReg = hw0 & 0xf;
    const rdSat = (hw1 >>> 8) & 0xf;
    const satImm = hw1 & 0x1f;
    const satWidth = satImm + 1;
    const imm2sat = (hw1 >>> 6) & 0x3;
    const shiftAmt = (imm3 << 2) | imm2sat;
    let val = regs.r[rmReg] | 0;
    if (shiftAmt > 0) {
      val = isAsr ? val >> shiftAmt : val << shiftAmt;
    }
    if (isUnsigned) {
      // USAT: clamp to [0, 2^satWidth - 1]
      const max = satWidth >= 32 ? 0xffffffff : ((1 << satWidth) - 1) >>> 0;
      if (val < 0) {
        regs.r[rdSat] = 0;
        regs.setQ();
      } else if (val >>> 0 > max) {
        regs.r[rdSat] = max;
        regs.setQ();
      } else {
        regs.r[rdSat] = val >>> 0;
      }
    } else {
      // SSAT: clamp to [-2^(satWidth-1), 2^(satWidth-1) - 1]
      const maxPos = satWidth >= 32 ? 0x7fffffff : (1 << (satWidth - 1)) - 1;
      const minNeg = satWidth >= 32 ? -0x80000000 : -(1 << (satWidth - 1));
      if (val > maxPos) {
        regs.r[rdSat] = maxPos >>> 0;
        regs.setQ();
      } else if (val < minNeg) {
        regs.r[rdSat] = minNeg >>> 0;
        regs.setQ();
      } else {
        regs.r[rdSat] = val >>> 0;
      }
    }
    return 1;
  }
  return -1;
}

// ---- Long branch dispatch (BL, B.W T3/T4) ----
function dispatchLongBranch(
  core: CortexM33Core,
  opcodePC: number,
  hw0: number,
  hw1: number
): number {
  const regs = core.regs;
  const s = (hw0 >>> 10) & 0x1;
  const pc4 = (opcodePC + 4) >>> 0; // PC reads as instruction address + 4
  const j1 = (hw1 >>> 13) & 0x1;
  const j2 = (hw1 >>> 11) & 0x1;
  const imm11 = hw1 & 0x7ff;

  // Sub-dispatch per ARMv8-M: hw1[14]=1 → BL; else hw1[12]=1 → B.W T4
  // (unconditional); else hw1[12]=0 → B.W T3 (conditional), unless hw0[9:6] is
  // 0b111x (miscellaneous control, handled elsewhere).
  if (((hw1 >>> 14) & 0x1) === 1) {
    // BL (T1). Extended-range I1/I2 = NOT(Jn XOR S).
    const i1 = j1 ^ s ^ 1;
    const i2 = j2 ^ s ^ 1;
    const imm10 = hw0 & 0x3ff;
    const imm25 = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1);
    const offset = signExtend(imm25, 25);
    regs.lr = (pc4 | 1) >>> 0;
    regs.pc = (pc4 + offset) >>> 0;
    core.blTaken(core, false);
    return 4;
  }

  if (((hw1 >>> 12) & 0x1) === 1) {
    // B.W T4 (unconditional). Same extended-range I1/I2 as BL.
    const i1 = j1 ^ s ^ 1;
    const i2 = j2 ^ s ^ 1;
    const imm10 = hw0 & 0x3ff;
    const imm25 = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1);
    const offset = signExtend(imm25, 25);
    regs.pc = (pc4 + offset) >>> 0;
    return 3;
  }

  // hw1[14]=0, hw1[12]=0.
  const cond = (hw0 >>> 6) & 0xf; // T3 condition lives in hw0[9:6]
  if ((cond & 0xe) === 0xe) {
    return -1; // 0b111x → miscellaneous control (not handled here)
  }
  // B.W T3 (conditional). J1/J2 used directly (no XOR); 21-bit offset.
  const imm6 = hw0 & 0x3f;
  const imm21 = (s << 20) | (j2 << 19) | (j1 << 18) | (imm6 << 12) | (imm11 << 1);
  const offset = signExtend(imm21, 21);
  if (conditionPassed(regs, cond)) {
    regs.pc = (pc4 + offset) >>> 0;
  }
  return 1;
}

// ---- Misc control (MRS, MSR, DSB/DMB/ISB, CLREX) ----
// ---- DP shifted register ----
function dispatchDpShiftedReg(core: CortexM33Core, hw0: number, hw1: number): number {
  const regs = core.regs;
  // Encoding: hw0[15:9]=0b1110101, op=hw0[8:5], S=hw0[4], Rn=hw0[3:0].
  // hw1 = imm3 Rd imm2 type Rm.
  const op = (hw0 >>> 5) & 0xf;
  const setFlags = (hw0 & 0x10) !== 0;
  const rn = hw0 & 0xf;
  const rd = (hw1 >>> 8) & 0xf;
  const rm = hw1 & 0xf;
  const imm3 = (hw1 >>> 12) & 0x7;
  const imm2 = (hw1 >>> 6) & 0x3;
  const shiftType = (hw1 >>> 4) & 0x3;
  const shiftAmt = (imm3 << 2) | imm2;
  const rnVal = rn === 15 ? regs.pc : regs.r[rn];
  const rmVal = regs.r[rm];

  // Apply the immediate-specified barrel shift to Rm, tracking the shifter
  // carry-out (ARMv8-M Shift_C / DecodeImmShift). An encoded amount of 0 means
  // LSR/ASR #32 and ROR → RRX.
  let shifted = 0;
  let shiftCarry = regs.C;
  switch (shiftType) {
    case 0: // LSL
      if (shiftAmt === 0) {
        shifted = rmVal;
      } else {
        shifted = (rmVal << shiftAmt) >>> 0;
        shiftCarry = ((rmVal >>> (32 - shiftAmt)) & 1) !== 0;
      }
      break;
    case 1: // LSR (#32 when amount 0)
      if (shiftAmt === 0) {
        shifted = 0;
        shiftCarry = rmVal >>> 31 !== 0;
      } else {
        shifted = rmVal >>> shiftAmt;
        shiftCarry = ((rmVal >>> (shiftAmt - 1)) & 1) !== 0;
      }
      break;
    case 2: // ASR (#32 when amount 0)
      if (shiftAmt === 0) {
        shifted = ((rmVal | 0) >> 31) >>> 0;
        shiftCarry = rmVal >>> 31 !== 0;
      } else {
        shifted = ((rmVal | 0) >> shiftAmt) >>> 0;
        shiftCarry = (((rmVal | 0) >> (shiftAmt - 1)) & 1) !== 0;
      }
      break;
    default: // ROR, or RRX when amount 0
      if (shiftAmt === 0) {
        shifted = ((regs.C ? 0x80000000 : 0) | (rmVal >>> 1)) >>> 0;
        shiftCarry = (rmVal & 1) !== 0;
      } else {
        const r = shiftAmt & 31;
        shifted = r === 0 ? rmVal >>> 0 : ((rmVal >>> r) | (rmVal << (32 - r))) >>> 0;
        shiftCarry = shifted >>> 31 !== 0;
      }
      break;
  }

  // Logical ops set N/Z from result and C from the shifter carry when S=1.
  const writeLogical = (result: number, isTest: boolean) => {
    if (!isTest) writeDpResult(core, rd, result);
    if (setFlags) {
      regs.setNZ(result);
      regs.C = shiftCarry;
    }
  };

  switch (op) {
    case 0b0000: // AND / TST (S=1, Rd=15)
      writeLogical((rnVal & shifted) >>> 0, setFlags && rd === 15);
      return 1;
    case 0b0001: // BIC
      writeLogical((rnVal & ~shifted) >>> 0, false);
      return 1;
    case 0b0010: // ORR / MOV
      writeLogical(rn === 15 ? shifted >>> 0 : (rnVal | shifted) >>> 0, false);
      return 1;
    case 0b0011: // ORN / MVN
      writeLogical(rn === 15 ? ~shifted >>> 0 : (rnVal | ~shifted) >>> 0, false);
      return 1;
    case 0b0100: // EOR / TEQ (S=1, Rd=15)
      writeLogical((rnVal ^ shifted) >>> 0, setFlags && rd === 15);
      return 1;
    case 0b1000: {
      // ADD / CMN (S=1, Rd=15 → flags only)
      const result = addSubFlags(core, rnVal, shifted, true, 0, setFlags);
      if (!(setFlags && rd === 15)) writeDpResult(core, rd, result);
      return 1;
    }
    case 0b1010: // ADC
      writeDpResult(core, rd, addSubFlags(core, rnVal, shifted, true, regs.C ? 1 : 0, setFlags));
      return 1;
    case 0b1011: // SBC
      writeDpResult(
        core,
        rd,
        addSubFlags(core, rnVal, shifted + (regs.C ? 0 : 1), false, 0, setFlags)
      );
      return 1;
    case 0b1101: {
      // SUB / CMP (S=1, Rd=15 → flags only)
      const result = addSubFlags(core, rnVal, shifted, false, 0, setFlags);
      if (!(setFlags && rd === 15)) writeDpResult(core, rd, result);
      return 1;
    }
    case 0b1110: // RSB
      writeDpResult(core, rd, addSubFlags(core, shifted, rnVal, false, 0, setFlags));
      return 1;
    default:
      return -1;
  }
}

// `setFlags` defaults to true for CMN/CMP (which always update flags per their
// encoding forcing S=1); ADD/ADC/SBC/SUB/RSB pass the instruction's actual S
// bit explicitly. Previously this unconditionally wrote NZCV regardless of S,
// so a plain (S=0) `ADD.W Rd,Rn,#imm`/`ADD.W Rd,Rn,Rm,<shift>` silently
// clobbered flags set by an immediately preceding CMP — e.g. a `cmp r7,r5;
// add.w r4,r4,#8; bne ...` loop-increment idiom (seen in MicroPython's
// mp_map_rehash) would always re-clear Z after the CMP, making `bne` branch
// unconditionally and loop forever past the real exit condition.
function addSubFlags(
  core: CortexM33Core,
  a: number,
  b: number,
  isAdd: boolean,
  carryIn = 0,
  setFlags = true
): number {
  const regs = core.regs;
  if (isAdd) {
    // Carry/overflow via 32-bit bit tricks; `carryIn` kept separate from `b` —
    // both for the same reasons as execute-thumb16.ts's addFlags (see there).
    const au = a >>> 0;
    const bu = b >>> 0;
    const step1 = (au + bu) >>> 0;
    const carryOut1 = au > 0xffffffff - bu;
    const r = (step1 + carryIn) | 0;
    const carryOut2 = carryIn !== 0 && step1 === 0xffffffff;
    if (setFlags) {
      regs.N = (r & 0x80000000) !== 0;
      regs.Z = (r & 0xffffffff) === 0;
      regs.C = carryOut1 || carryOut2;
      regs.V = (~(a ^ b) & (a ^ r)) < 0;
    }
    return r & 0xffffffff;
  }
  const r = (a - b) >>> 0;
  if (setFlags) {
    regs.N = (r & 0x80000000) !== 0;
    regs.Z = r === 0;
    regs.C = a >>> 0 >= b >>> 0;
    regs.V = ((a ^ b) & (a ^ r)) < 0;
  }
  return r;
}

// ---- Load/store single (LDR.W/STR.W/LDRH/STRH/LDRB/STRB/LDRSB/LDRSH) ----
// Encoding (ARMv8-M §A6.3.3):
//   hw0[7] = 1 → T3 (imm12):    hw0 = 11111 00 0 S size1 L Rn | Rt imm12
//   hw0[7] = 0 → T4/register:   hw0 = 11111 00 0 S size0 L Rn | Rt 1 0 P U W imm8
//                               hw1[11]=1 → register offset (hw1 = Rt 1 shift imm2 Rm)
//   hw0[6:5] = size: 00=byte, 01=half, 10=word
//   hw0[4]   = L:    1=load, 0=store
//   hw0[8]   = S:    sign-extend (for byte/halfword loads → LDRSB/LDRSH)
function dispatchLoadStoreSingle(
  core: CortexM33Core,
  opcodePC: number,
  hw0: number,
  hw1: number
): number {
  const regs = core.regs;
  const rn = hw0 & 0xf;
  const rt = (hw1 >>> 12) & 0xf;
  const isT3 = (hw0 & 0x80) !== 0; // hw0[7]
  const sizeBits = (hw0 >>> 5) & 0x3; // 00=byte, 01=half, 10=word
  const isLoad = (hw0 & 0x10) !== 0; // hw0[4]
  const sBit = (hw0 >>> 8) & 1; // sign-extend

  // Resolve size + sign into a single tag.
  const size: 'w' | 'h' | 'b' | 'sb' | 'sh' =
    sizeBits === 0
      ? sBit && isLoad
        ? 'sb'
        : 'b'
      : sizeBits === 1
      ? sBit && isLoad
        ? 'sh'
        : 'h'
      : 'w';

  // Compute address.
  let addr: number;
  let wbAddr = -1; // -1 = no writeback
  if (isT3) {
    const imm12 = hw1 & 0xfff;
    // LDR (literal), positive-offset form: when Rn=PC, the base is
    // Align(PC,4) — i.e. (opcodePC+4) rounded DOWN to a word boundary — per
    // ARMv8-M ARM's LDR-literal pseudocode, not the raw (possibly
    // 2-byte-aligned-only) instruction address. Without the `& ~3`, a 32-bit
    // LDR-literal sitting at a 2-mod-4 address (right after another 32-bit
    // instruction with no 16-bit filler) reads 2 bytes into the intended
    // literal and 2 bytes of the next one instead.
    const base = rn === 15 ? ((opcodePC + 4) & ~3) >>> 0 : regs.r[rn];
    addr = (base + imm12) >>> 0;
  } else if (rn === 15) {
    // LDR (literal), negative-offset sub-form: when Rn=PC (1111), bit 7 of
    // hw0 (the isT3 selector for Rn=0-14) is reinterpreted as the literal
    // encoding's U bit instead — isT3=false here means U=0 (subtract), and
    // hw1's low 12 bits are a plain imm12, NOT Rm/imm2 or P/U/W fields.
    // Verified against `arm-none-eabi-as`: `ldr.w r0,[pc,#-4]` assembles to
    // hw0=0xf85f (bit 7 clear) with hw1 = imm12, same shape as the T3
    // (positive-literal) form above but subtracting instead of adding. Same
    // Align(PC,4) requirement as the positive form above.
    const imm12 = hw1 & 0xfff;
    const base = ((opcodePC + 4) & ~3) >>> 0;
    addr = (base - imm12) >>> 0;
  } else {
    const base = regs.r[rn];
    let offset: number;
    // Bit 11 of hw1 is a *fixed* 1 in the immediate (T4, PUW+imm8) encoding;
    // the register-offset form (T2) instead has hw1[11:6] == 0b000000. So
    // bit 11 clear (not set) is what selects the register-offset form.
    if ((hw1 & 0x800) === 0) {
      // Register-offset form: hw1 = Rt 000000 imm2 Rm.
      const rm = hw1 & 0xf;
      const imm2 = (hw1 >>> 4) & 0x3;
      const rmVal = regs.r[rm] >>> 0;
      offset = (rmVal << imm2) >>> 0;
      addr = ((base + offset) & 0xffffffff) >>> 0;
    } else {
      // Immediate T4 with P/U/W.
      const p = (hw1 >>> 10) & 1;
      const u = (hw1 >>> 9) & 1;
      const w = (hw1 >>> 8) & 1;
      offset = u ? hw1 & 0xff : -(hw1 & 0xff);
      if (p === 0) {
        // Post-indexed: access at base, writeback to base+offset.
        addr = base;
        wbAddr = ((base + offset) & 0xffffffff) >>> 0;
      } else {
        // Pre-indexed: access at base+offset, writeback only if W=1.
        addr = ((base + offset) & 0xffffffff) >>> 0;
        if (w !== 0) wbAddr = addr;
      }
    }
  }

  // Perform the access.
  if (isLoad) {
    switch (size) {
      case 'w':
        regs.r[rt] = core.readUint32Unaligned(addr);
        break;
      case 'h':
        regs.r[rt] = core.readUint16Unaligned(addr);
        break;
      case 'b':
        regs.r[rt] = core.chip.readUint8(addr);
        break;
      case 'sb':
        regs.r[rt] = ((core.chip.readUint8(addr) << 24) >> 24) >>> 0;
        break;
      case 'sh':
        regs.r[rt] = ((core.readUint16Unaligned(addr) << 16) >> 16) >>> 0;
        break;
    }
  } else {
    switch (size) {
      case 'w':
        core.writeUint32Unaligned(addr, regs.r[rt]);
        break;
      case 'h':
        core.writeUint16Unaligned(addr, regs.r[rt] & 0xffff);
        break;
      case 'b':
        core.chip.writeUint8(addr, regs.r[rt] & 0xff);
        break;
    }
  }

  if (wbAddr >= 0 && rn !== 15) regs.r[rn] = wbAddr >>> 0;
  return 2;
}

// ---- Data processing (register) ----
function dispatchDpRegister(core: CortexM33Core, hw0: number, hw1: number): number {
  const regs = core.regs;
  const rn = hw0 & 0xf;
  const rd = (hw1 >>> 8) & 0xf;
  const rm = hw1 & 0xf;

  // Register-controlled shift (LSL/LSR/ASR/ROR Rd, Rn, Rm): hw0[7]=0 and
  // hw1[7:4]=0000. stype = hw0[6:5], S = hw0[4]; the amount is Rm[7:0]. Other
  // encodings in this class (extends, SXTAB, …) are not implemented yet.
  if ((hw0 & 0x80) === 0 && (hw1 & 0xf0) === 0) {
    const stype = (hw0 >>> 5) & 0x3;
    const setFlags = (hw0 & 0x10) !== 0;
    const shift = regs.r[rm] & 0xff;
    const value = regs.r[rn];
    let result = value;
    let carry = regs.C;
    switch (stype) {
      case 0b00: // LSL
        if (shift === 0) {
          result = value;
        } else if (shift < 32) {
          result = (value << shift) >>> 0;
          carry = ((value >>> (32 - shift)) & 1) !== 0;
        } else if (shift === 32) {
          result = 0;
          carry = (value & 1) !== 0;
        } else {
          result = 0;
          carry = false;
        }
        break;
      case 0b01: // LSR
        if (shift === 0) {
          result = value;
        } else if (shift < 32) {
          result = value >>> shift;
          carry = ((value >>> (shift - 1)) & 1) !== 0;
        } else if (shift === 32) {
          result = 0;
          carry = value >>> 31 !== 0;
        } else {
          result = 0;
          carry = false;
        }
        break;
      case 0b10: // ASR
        if (shift === 0) {
          result = value;
        } else if (shift < 32) {
          result = ((value | 0) >> shift) >>> 0;
          carry = (((value | 0) >> (shift - 1)) & 1) !== 0;
        } else {
          result = ((value | 0) >> 31) >>> 0;
          carry = (value & 0x80000000) !== 0;
        }
        break;
      default: {
        // ROR
        if (shift === 0) {
          result = value;
        } else {
          const eff = shift & 31;
          if (eff === 0) {
            result = value;
            carry = value >>> 31 !== 0;
          } else {
            result = ((value >>> eff) | (value << (32 - eff))) >>> 0;
            carry = result >>> 31 !== 0;
          }
        }
        break;
      }
    }
    result = result >>> 0;
    regs.r[rd] = result;
    if (setFlags) {
      regs.setNZ(result);
      regs.C = carry;
    }
    return 1;
  }

  // REV.W/REV16.W/RBIT/REVSH.W: hw0 = 0xfa90|Rm, hw1 = Rd(4) sel(4) Rm2(4),
  // sel selects the sub-op (0x8=REV, 0x9=REV16, 0xa=RBIT, 0xb=REVSH).
  // CLZ: hw0 = 0xfab0|Rm, hw1 = Rd(4) 0x8 Rm2(4). Verified against
  // `arm-none-eabi-as -march=armv8-m.main`.
  if ((hw0 & 0xfff0) === 0xfa90) {
    const input = regs.r[rm];
    const sel = hw1 & 0xf0;
    let result: number;
    switch (sel) {
      case 0x80: // REV
        result =
          (((input & 0xff) << 24) |
            (((input >>> 8) & 0xff) << 16) |
            (((input >>> 16) & 0xff) << 8) |
            ((input >>> 24) & 0xff)) >>>
          0;
        break;
      case 0x90: // REV16
        result =
          ((((input >>> 16) & 0xff) << 24) |
            (((input >>> 24) & 0xff) << 16) |
            ((input & 0xff) << 8) |
            ((input >>> 8) & 0xff)) >>>
          0;
        break;
      case 0xa0: // RBIT
        {
          let v = input >>> 0;
          let r = 0;
          for (let i = 0; i < 32; i++) {
            r = ((r << 1) | (v & 1)) >>> 0;
            v >>>= 1;
          }
          result = r;
        }
        break;
      default: // 0xb0: REVSH
        result = (((((input & 0xff) << 8) | ((input >>> 8) & 0xff)) << 16) >> 16) >>> 0;
        break;
    }
    regs.r[rd] = result;
    return 1;
  }
  if ((hw0 & 0xfff0) === 0xfab0) {
    // CLZ
    const input = regs.r[rm] >>> 0;
    let count = 0;
    let v = input;
    if (v === 0) {
      count = 32;
    } else {
      while ((v & 0x80000000) === 0) {
        count++;
        v = (v << 1) >>> 0;
      }
    }
    regs.r[rd] = count;
    return 1;
  }
  // SXTH.W/UXTH.W/SXTB.W/UXTB.W (Rn=0xf, plain) and their DSP-extension
  // accumulating counterparts SXTAH/UXTAH/SXTAB/UXTAB (Rn=a real register,
  // added to the extended result) share one encoding family: hw0 = 0xfa0n|
  // 1n|4n|5n (top byte 0xfa, subop in bits[7:4], Rn in bits[3:0] — 0xf
  // selects the plain/non-accumulating form), hw1 = Rd(4) 10(2) rotate(2)
  // Rm(4) — rotate selects ROR #0/8/16/24 applied to Rm before the sign/
  // zero extend. Verified against `arm-none-eabi-as -march=armv8-m.main
  // +dsp` (RP2350's M33 includes the DSP extension). SXTAB16/UXTAB16
  // (subop 0x2/0x3, packed 16x2-lane accumulate) are a distinct SIMD op and
  // aren't implemented.
  if ((hw0 & 0xff00) === 0xfa00) {
    const subop = (hw0 >>> 4) & 0xf;
    if (subop === 0x0 || subop === 0x1 || subop === 0x4 || subop === 0x5) {
      const rotate = ((hw1 >>> 4) & 0x3) * 8;
      const rmVal = regs.r[rm] >>> 0;
      const rotated = rotate === 0 ? rmVal : ((rmVal >>> rotate) | (rmVal << (32 - rotate))) >>> 0;
      let extended: number;
      switch (subop) {
        case 0x0: // SXTH / SXTAH
          extended = ((rotated << 16) >> 16) >>> 0;
          break;
        case 0x1: // UXTH / UXTAH
          extended = rotated & 0xffff;
          break;
        case 0x4: // SXTB / SXTAB
          extended = ((rotated << 24) >> 24) >>> 0;
          break;
        default: // 0x5: UXTB / UXTAB
          extended = rotated & 0xff;
      }
      regs.r[rd] = rn === 0xf ? extended : (regs.r[rn] + extended) >>> 0;
      return 1;
    }
  }
  return -1;
}

// ---- Multiply / divide ----
function dispatchMultiply(core: CortexM33Core, hw0: number, hw1: number): number {
  const regs = core.regs;
  // op = hw0[7:4]. The 32-bit-result multiply class (op1 = hw0[6:4]) shares
  // hw0[7:4]=0000 with the 64-bit-result long-multiply class (which sets
  // hw0[7]=1), so the full 4-bit op cleanly separates them. op2 = hw1[7:4].
  //   0000 → MUL/MLA (op2[1:0]=00) / MLS (op2[1:0]=01)
  //   1000 → SMULL, 1010 → UMULL, 1100 → SMLAL, 1110 → UMLAL  (op2=0000)
  //   1001 → SDIV,  1011 → UDIV                            (op2=1111)
  const op = (hw0 >>> 4) & 0xf;
  const op2 = (hw1 >>> 4) & 0xf;
  const rn = hw0 & 0xf;
  const ra = (hw1 >>> 12) & 0xf; // also RdLo for long multiply
  const rd = (hw1 >>> 8) & 0xf; // also RdHi for long multiply
  const rm = hw1 & 0xf;

  if (op === 0b0001) {
    // SMULxy/SMLAxy (DSP extension): 16x16 signed multiply of a half-word
    // from Rn and a half-word from Rm, optionally accumulated into Ra.
    // op2[1:0] = (N<<1)|M selects which half of Rn (N, bit5) and Rm (M,
    // bit4) participates: 0=bottom halfword, 1=top halfword. Ra=0b1111
    // selects the non-accumulating SMULxy form (no Q flag — the 16x16
    // product always fits in 32 bits); otherwise SMLAxy adds Ra and sets Q
    // (sticky overflow) on signed 32-bit overflow, per ARMv8-M ARM.
    // Verified against `arm-none-eabi-as -march=armv8-m.main+dsp`.
    const nBit = (op2 >>> 1) & 1;
    const mBit = op2 & 1;
    const nHalf = nBit ? regs.r[rn] >> 16 : (regs.r[rn] << 16) >> 16;
    const mHalf = mBit ? regs.r[rm] >> 16 : (regs.r[rm] << 16) >> 16;
    const product = nHalf * mHalf;
    if (ra === 0xf) {
      regs.r[rd] = product >>> 0;
    } else {
      const acc = regs.r[ra] | 0;
      const sum = acc + product;
      regs.r[rd] = sum >>> 0;
      if (sum > 0x7fffffff || sum < -0x80000000) {
        regs.setQ();
      }
    }
    return 1;
  }
  if (op === 0b0101) {
    // SMMLA/SMMLAR/SMMUL/SMMULR (DSP extension): signed modular multiply —
    // the high 32 bits of a 32x32→64 signed product, optionally rounded (R
    // bit at hw1[4]) and accumulated into Ra. Field layout is the same as the
    // MLA class: Ra = hw1[15:12], Rd = hw1[11:8], Rm = hw1[3:0], Rn = hw0[3:0].
    // Ra = 0b1111 selects the non-accumulating SMMUL form. Verified against
    // `arm-none-eabi-as` / capstone decodes.
    const round = (hw1 >>> 4) & 1;
    mul64Signed(regs.r[rn], regs.r[rm], core.mul64Scratch);
    const hi = core.mul64Scratch.hi;
    const lo = core.mul64Scratch.lo;
    // Add 2^31 before taking the high word when rounding: this increments the
    // high word exactly when the low word is >= 0x80000000.
    let prodHi = hi | 0; // signed high word of the 64-bit product
    if (round && lo >>> 0 >= 0x80000000) prodHi = (prodHi + 1) | 0;
    const acc = ra === 0xf ? 0 : regs.r[ra] | 0;
    regs.r[rd] = (prodHi + acc) >>> 0;
    return 1;
  }
  if (op === 0b0000) {
    // op1 = 000: MUL/MLA vs MLS, discriminated by op2[1:0] (hw1[5:4]).
    if ((op2 & 0x3) === 0b01) {
      // MLS: Rd = Ra - Rn*Rm
      regs.r[rd] = ((regs.r[ra] | 0) - Math.imul(regs.r[rn] | 0, regs.r[rm] | 0)) >>> 0;
      return 2;
    }
    if (ra === 0xf) {
      // MUL.W
      regs.r[rd] = Math.imul(regs.r[rn] | 0, regs.r[rm] | 0) >>> 0;
      return 2;
    }
    // MLA: Rd = Rn*Rm + Ra
    regs.r[rd] = (Math.imul(regs.r[rn] | 0, regs.r[rm] | 0) + (regs.r[ra] | 0)) >>> 0;
    return 2;
  }
  if (op === 0b1011) {
    // UDIV — ARMv8-M without DIV_0_TRP returns 0 on divide-by-zero.
    const divisor = regs.r[rm] >>> 0;
    const dividend = regs.r[rn] >>> 0;
    regs.r[rd] = divisor === 0 ? 0 : ((dividend >>> 0) / (divisor >>> 0)) >>> 0;
    return 12;
  }
  if (op === 0b1001) {
    // SDIV
    const divisor = regs.r[rm] | 0;
    const dividend = regs.r[rn] | 0;
    if (divisor === 0) {
      regs.r[rd] = 0;
    } else {
      regs.r[rd] = ((dividend / divisor) | 0) >>> 0;
    }
    return 12;
  }
  // 64-bit-result long multiply. RdLo = hw1[15:12], RdHi = hw1[11:8].
  const rdLo = ra;
  const rdHi = rd;
  if (op === 0b1000) {
    // SMULL: signed Rn * Rm → RdHi:RdLo
    mul64Signed(regs.r[rn], regs.r[rm], core.mul64Scratch);
    const hi = core.mul64Scratch.hi;
    const lo = core.mul64Scratch.lo;
    regs.r[rdLo] = lo;
    regs.r[rdHi] = hi;
    return 2;
  }
  if (op === 0b1010) {
    // UMULL: unsigned Rn * Rm → RdHi:RdLo
    mul64(regs.r[rn] >>> 0, regs.r[rm] >>> 0, core.mul64Scratch);
    const hi = core.mul64Scratch.hi;
    const lo = core.mul64Scratch.lo;
    regs.r[rdLo] = lo;
    regs.r[rdHi] = hi;
    return 2;
  }
  if (op === 0b1100) {
    // SMLAL: signed Rn*Rm + RdHi:RdLo → RdHi:RdLo
    const acc = (regs.r[rdHi] >>> 0) * 0x100000000 + (regs.r[rdLo] >>> 0);
    mul64Signed(regs.r[rn], regs.r[rm], core.mul64Scratch);
    const hi = core.mul64Scratch.hi;
    const lo = core.mul64Scratch.lo;
    const product = (hi >>> 0) * 0x100000000 + (lo >>> 0);
    const signedAcc = acc > 0x7fffffffffffffff ? acc - 0x10000000000000000 : acc;
    const signedProd = product > 0x7fffffffffffffff ? product - 0x10000000000000000 : product;
    const sum = signedAcc + signedProd;
    const u64 = sum < 0 ? sum + 0x10000000000000000 : sum;
    regs.r[rdLo] = u64 & 0xffffffff;
    regs.r[rdHi] = (u64 / 0x100000000) & 0xffffffff;
    return 2;
  }
  if (op === 0b1110) {
    // UMLAL: unsigned Rn*Rm + RdHi:RdLo → RdHi:RdLo
    const acc = (regs.r[rdHi] >>> 0) * 0x100000000 + (regs.r[rdLo] >>> 0);
    mul64(regs.r[rn] >>> 0, regs.r[rm] >>> 0, core.mul64Scratch);
    const hi = core.mul64Scratch.hi;
    const lo = core.mul64Scratch.lo;
    const product = (hi >>> 0) * 0x100000000 + (lo >>> 0);
    const sum = acc + product;
    regs.r[rdLo] = sum & 0xffffffff;
    regs.r[rdHi] = (sum / 0x100000000) & 0xffffffff;
    return 2;
  }
  return -1;
}

// ---- Special register access ----
function readSpecialRegister(core: CortexM33Core, sysm: number): number {
  const regs = core.regs;
  switch (sysm) {
    case 0: // APSR
      return regs.xpsr & 0xf8000000;
    case 1: // IAPSR
      return regs.xpsr & 0x07000000;
    case 3: // XPSR
      return (regs.xpsr & 0xff000000) >>> 0;
    case 5: // IPSR
      return regs.ipsr;
    case 8: // MSP
      return regs.msp;
    case 9: // PSP
      return regs.psp;
    // SP limit registers: SYSm 0x0A / 0x0B (not 0x84/0x85).
    case 0x0a: // MSPLIM
      return regs.msplim;
    case 0x0b: // PSPLIM
      return regs.psplim;
    case 16: // PRIMASK
      return regs.primask & 1;
    case 17: // BASEPRI
      return regs.basepri & 0xff;
    case 18: // BASEPRI_MAX
      return regs.basepri & 0xff;
    case 19: // FAULTMASK
      return regs.faultmask & 1;
    case 20: // CONTROL
      return regs.control & 0x7;
    // --- Non-Secure banked registers (SYSm bit 7 = NS) ---
    case 0x88: // MSP_NS
      return regs.msp_ns;
    case 0x89: // PSP_NS
      return regs.psp_ns;
    case 0x8a: // MSPLIM_NS
      return regs.msplim_ns;
    case 0x8b: // PSPLIM_NS
      return regs.psplim_ns;
    case 0x90: // PRIMASK_NS
      return regs.primask_ns & 1;
    case 0x91: // BASEPRI_NS
      return regs.basepri_ns & 0xff;
    case 0x93: // FAULTMASK_NS
      return regs.faultmask_ns & 1;
    case 0x94: // CONTROL_NS
      return regs.control_ns & 0x7;
    default:
      core.logger.warn(core.coreLabel, `MRS with unimplemented SYSm: ${sysm}`);
      return 0;
  }
}

function writeSpecialRegister(core: CortexM33Core, sysm: number, value: number) {
  const regs = core.regs;
  switch (sysm) {
    case 0: // APSR
      regs.xpsr = (regs.xpsr & ~0xf8000000) | (value & 0xf8000000);
      break;
    case 1: // IAPSR
      regs.xpsr = (regs.xpsr & ~0x07000000) | (value & 0x07000000);
      break;
    case 5: // IPSR (read-only in Handler; ignored)
      break;
    case 8:
      regs.msp = value & ~3;
      // `regs.sp` (r[13]) is a plain register alias, not a live view of
      // msp/psp — writing the banked value alone leaves the *active* SP
      // stale if MSP happens to be the one currently in use (Handler mode,
      // or Thread mode with CONTROL.SPSEL=0). Real bootrom code does
      // exactly this (`msr msp, r0`) as part of handing off to a freshly
      // launched image's own stack; without this sync, the image silently
      // keeps running on the bootrom's old (e.g. BOOTRAM-scratch) stack.
      regs.syncSpFromBanked();
      break;
    case 9:
      regs.psp = value & ~3;
      regs.syncSpFromBanked();
      break;
    case 16:
      regs.primask = value & 1;
      core.interruptsUpdated = true;
      break;
    case 17:
      regs.basepri = value & 0xff;
      core.interruptsUpdated = true;
      break;
    case 18: // BASEPRI_MAX
      if ((value & 0xff) < regs.basepri || regs.basepri === 0) {
        regs.basepri = value & 0xff;
        core.interruptsUpdated = true;
      }
      break;
    case 19:
      regs.faultmask = value & 1;
      core.interruptsUpdated = true;
      break;
    case 20:
      // CONTROL — nPRIV/SPSEL only. MSR cannot change FPCA (bit 2), which is
      // owned exclusively by FP execution and exception entry/exit.
      // Changing SPSEL changes which banked register (msp/psp) is "active"
      // (see registers.ts activeSpIsPsp) — save r[13] to the old one and
      // reload it from the new one, the same as an exception-entry/exit
      // mode switch does.
      regs.syncSpToBanked();
      regs.control = (value & 0x3) | (regs.control & 0x4);
      regs.syncSpFromBanked();
      break;
    case 0x0a:
      // MSPLIM — 8-byte aligned (SYSm 0x0A, not 0x84).
      regs.msplim = value & ~0x7;
      break;
    case 0x0b:
      // PSPLIM — 8-byte aligned (SYSm 0x0B, not 0x85).
      regs.psplim = value & ~0x7;
      break;
    case 0x88:
      regs.msp_ns = value & ~3;
      break;
    case 0x89:
      regs.psp_ns = value & ~3;
      break;
    case 0x8a:
      // MSPLIM_NS (SYSm 0x8A).
      regs.msplim_ns = value & ~0x7;
      break;
    case 0x8b:
      // PSPLIM_NS (SYSm 0x8B).
      regs.psplim_ns = value & ~0x7;
      break;
    case 0x90:
      // PRIMASK_NS (SYSm 0x90, not 0x94).
      regs.primask_ns = value & 1;
      break;
    case 0x91:
      // BASEPRI_NS (SYSm 0x91, not 0x95).
      regs.basepri_ns = value & 0xff;
      break;
    case 0x93:
      // FAULTMASK_NS (SYSm 0x93, not 0x96).
      regs.faultmask_ns = value & 1;
      break;
    case 0x94: {
      // CONTROL_NS (SYSm 0x94, not 0x98) — same FPCA-preservation rule.
      regs.control_ns = (value & 0x3) | (regs.control_ns & 0x4);
      break;
    }
    default:
      core.logger.warn(core.coreLabel, `MSR with unimplemented SYSm: ${sysm}`);
  }
}
