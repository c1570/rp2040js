/**
 * Cortex-M33 Thumb-16 instruction executor.
 *
 * Reference: ARMv8-M Architecture Reference Manual §A6.2 (Thumb-16 encodings).
 */

import { CortexM33Core } from './core';
import { conditionPassed } from './conditions';

const spRegister = 13;
const pcRegister = 15;

function signExtend8(value: number) {
  return (value << 24) >> 24;
}

function signExtend16(value: number) {
  return (value << 16) >> 16;
}

/** Read an unsigned 8-bit byte. */
function readU8(core: CortexM33Core, address: number): number {
  return core.chip.readUint8(address);
}

/**
 * Read a 32-bit word assuming word alignment. LDM/POP require natural
 * alignment on the M33 and fault otherwise — this is the strict path used
 * by those multi-register forms (`core.chip.readUint32` throws on
 * misalignment). Single-register LDR/LDRH use `core.readUint32Unaligned`/
 * `core.readUint16Unaligned` instead, which the M33 permits to be unaligned.
 */
function readU32(core: CortexM33Core, address: number): number {
  return core.chip.readUint32(address) >>> 0;
}

/** IT block state advance: rotate the mask field right by 1 and clear if done. */
function advanceItState(core: CortexM33Core) {
  // ITAdvance (ARMv8-M A7.3.2): ITSTATE[7:4] is the effective condition for the
  // current instruction and ITSTATE[3:0] is the mask. On each step, if the low
  // three mask bits are zero the block ends; otherwise shift ITSTATE[4:0] left
  // by one, which moves the next then/else bit into cond[0] (bit 4).
  const it = core.regs.itState;
  if ((it & 0x7) === 0) {
    core.regs.itState = 0;
  } else {
    core.regs.itState = (it & 0xe0) | ((it << 1) & 0x1f);
  }
}

/** Cycle cost helper for I/O (mirrors cortex-m0-core.ts cyclesIO). */
function cyclesIO(core: CortexM33Core, addr: number, write = false): number {
  addr = addr >>> 0;
  const chip = core.chip;
  // SIO region: single-cycle on RP2350.
  if (addr >= 0xd0000000 && addr < 0xe0000000) return 0;
  // APB peripherals: read 3, write 4.
  if (addr >= 0x40000000 && addr < 0x50000000) return write ? 4 : 3;
  void chip;
  return 1;
}

/** Subtract with flags update (used by CMP, SUBS, RSBS, SBCS). */
// `setFlags` defaults to true for CMP/CMN (which always update flags); the
// handful of ADDS/SUBS/ADCS/NEGS/SBCS call sites that are conditionally
// flag-setting per ARMv8-M ("setflags = !InITBlock()" — several 16-bit
// encodings silently drop their 'S' when executed inside an IT block) pass
// `!inItBlock` explicitly.
function subFlags(
  core: CortexM33Core,
  minuend: number,
  subtrahend: number,
  setFlags = true
): number {
  const result = (minuend - subtrahend) >>> 0;
  if (setFlags) {
    core.regs.N = (result & 0x80000000) !== 0;
    core.regs.Z = result === 0;
    core.regs.C = minuend >>> 0 >= subtrahend;
    core.regs.V = ((minuend ^ subtrahend) & (minuend ^ result)) < 0;
  }
  return result;
}

/** Add with flags update (used by ADDS, ADCS, CMN). See `subFlags` re: setFlags. */
// Carry/overflow use 32-bit bit tricks, not an exact-sum comparison: cts2c
// models every `number` as a 32-bit-wrapping `int32_t`, so `a + b` IS the
// truncating operation and a "compare against the >>> 0'd copy" carry check
// would always be false in the C build. (JS's exact-double `number` makes
// that trick work, but it doesn't survive transpilation.)
//
// `carryIn` is a separate parameter rather than pre-folded into `b`: folding
// a carry-in of 1 into b=0xffffffff would yield 0x100000000, which doesn't
// survive a cts2c `int32_t` parameter (silently truncates to 0). Taking it
// separately and chaining two 32-bit-safe adds avoids any out-of-range value.
function addFlags(core: CortexM33Core, a: number, b: number, carryIn = 0, setFlags = true): number {
  const au = a >>> 0;
  const bu = b >>> 0;
  const step1 = (au + bu) >>> 0;
  const carryOut1 = au > 0xffffffff - bu;
  const result = (step1 + carryIn) | 0;
  const carryOut2 = carryIn !== 0 && step1 === 0xffffffff;
  if (setFlags) {
    core.regs.N = (result & 0x80000000) !== 0;
    core.regs.Z = (result & 0xffffffff) === 0;
    core.regs.C = carryOut1 || carryOut2;
    // Signed overflow: operands share a sign but the result's differs (standard
    // full-adder formula). Exact for carryIn=0; ADCS's rare
    // carry-across-0xffffffff edge case is only approximated — no real firmware
    // hits it, so a fully carry-aware variant isn't worth the complexity.
    core.regs.V = (~(a ^ b) & (a ^ result)) < 0;
  }
  return result & 0xffffffff;
}

/**
 * Execute one Thumb-16 instruction at `opcodePC`. Returns elapsed cycles.
 * The caller has already advanced PC past the 16-bit opcode (PC = opcodePC + 2).
 */
export function executeThumb16(core: CortexM33Core, opcodePC: number, opcode: number): number {
  const regs = core.regs;
  let deltaCycles = 1;
  // Several 16-bit Thumb encodings (ADCS/ADDS/ANDS/ASRS/BICS/EORS/LSLS/LSRS/
  // MOVS/MULS/MVNS/NEGS/ORRS/RORS/SBCS/SUBS — everything except CMN/CMP/TST,
  // which always set flags) suppress flag-setting when executed inside an IT
  // block — ARMv8-M pseudocode `setflags = !InITBlock()`. This is distinct
  // from IT-conditional *execution*, which the caller handles separately.
  const inItBlock = regs.itState !== 0;

  // ADCS
  if (opcode >> 6 === 0b0100000101) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    regs.r[Rdn] = addFlags(core, regs.r[Rm], regs.r[Rdn], regs.C ? 1 : 0, !inItBlock);
  }
  // ADD (register = SP plus immediate)
  else if (opcode >> 11 === 0b10101) {
    const imm8 = opcode & 0xff;
    const Rd = (opcode >> 8) & 0x7;
    regs.r[Rd] = (regs.sp + (imm8 << 2)) >>> 0;
  }
  // ADD (SP plus immediate)
  else if (opcode >> 7 === 0b101100000) {
    const imm32 = (opcode & 0x7f) << 2;
    regs.sp = (regs.sp + imm32) >>> 0;
  }
  // ADDS (Encoding T1)
  else if (opcode >> 9 === 0b0001110) {
    const imm3 = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = addFlags(core, regs.r[Rn], imm3, 0, !inItBlock);
  }
  // ADDS (Encoding T2)
  else if (opcode >> 11 === 0b00110) {
    const imm8 = opcode & 0xff;
    const Rdn = (opcode >> 8) & 0x7;
    regs.r[Rdn] = addFlags(core, regs.r[Rdn], imm8, 0, !inItBlock);
  }
  // ADDS (register)
  else if (opcode >> 9 === 0b0001100) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = addFlags(core, regs.r[Rn], regs.r[Rm], 0, !inItBlock);
  }
  // ADD (register — high) / MOV (high) / CMP (high) / BX / BLX
  else if (opcode >> 8 === 0b01000100) {
    // ADD (register): 01000100 Rm(3) DN(1) Rdn(3)
    const Rm = (opcode >> 3) & 0xf;
    const Rdn = ((opcode & 0x80) >> 4) | (opcode & 0x7);
    const leftValue = Rdn === pcRegister ? regs.pc + 2 : regs.r[Rdn];
    const rightValue = regs.r[Rm];
    const result = leftValue + rightValue;
    if (Rdn !== spRegister && Rdn !== pcRegister) {
      regs.r[Rdn] = result >>> 0;
    } else if (Rdn === pcRegister) {
      regs.pc = (result & ~0x1) >>> 0;
      deltaCycles++;
    } else if (Rdn === spRegister) {
      // ARM ADD SP,SP,Rm does NOT align to 4 bytes (only d==15 masks, with ~1).
      regs.r[Rdn] = result >>> 0;
    }
  }
  // ADR
  else if (opcode >> 11 === 0b10100) {
    const imm8 = opcode & 0xff;
    const Rd = (opcode >> 8) & 0x7;
    regs.r[Rd] = ((opcodePC & 0xfffffffc) + 4 + (imm8 << 2)) >>> 0;
  }
  // ANDS (Encoding T2)
  else if (opcode >> 6 === 0b0100000000) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const result = (regs.r[Rdn] & regs.r[Rm]) >>> 0;
    regs.r[Rdn] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
    }
  }
  // ASRS (immediate)
  else if (opcode >> 11 === 0b00010) {
    const imm5 = (opcode >> 6) & 0x1f;
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    const input = regs.r[Rm];
    const shiftN = imm5 ? imm5 : 32;
    const result = shiftN < 32 ? input >> shiftN : (input & 0x80000000) >> 31;
    regs.r[Rd] = result >>> 0;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
      regs.C = (input & (1 << (shiftN - 1))) !== 0;
    }
  }
  // ASRS (register)
  else if (opcode >> 6 === 0b0100000100) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const input = regs.r[Rdn];
    const shiftAmount = regs.r[Rm] & 0xff;
    const signedInput = input | 0;
    let result: number;
    let carry: boolean;
    if (shiftAmount === 0) {
      result = input;
      carry = regs.C;
    } else if (shiftAmount < 32) {
      result = (signedInput >> shiftAmount) >>> 0;
      carry = ((signedInput >> (shiftAmount - 1)) & 0x1) !== 0;
    } else {
      result = (signedInput >> 31) >>> 0;
      carry = signedInput < 0;
    }
    regs.r[Rdn] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
      regs.C = carry;
    }
  }
  // B (with cond)
  else if (opcode >> 12 === 0b1101 && ((opcode >> 9) & 0x7) !== 0b111) {
    let imm8 = (opcode & 0xff) << 1;
    const cond = (opcode >> 8) & 0xf;
    if (imm8 & (1 << 8)) imm8 = (imm8 & 0x1ff) - 0x200;
    if (conditionPassed(regs, cond)) {
      regs.pc = (regs.pc + imm8 + 2) >>> 0;
      deltaCycles++;
    }
  }
  // B (unconditional T2)
  else if (opcode >> 11 === 0b11100) {
    // test for profiler trace magic
    if (
      core.chip.readUint16(opcodePC + 2) === 0xabcd &&
      core.chip.readUint16(opcodePC + 4) === 0xffff
    ) {
      let profTag = '';
      for (let i = opcodePC + 6; ; i++) {
        const ch = core.chip.readUint8(i);
        if (ch === 0) break;
        profTag += String.fromCharCode(ch);
      }
      core.chip.onTrace(core.coreIndex, opcodePC, profTag);
    }
    let imm11 = (opcode & 0x7ff) << 1;
    if (imm11 & (1 << 11)) imm11 = (imm11 & 0x7ff) - 0x800;
    regs.pc = (regs.pc + imm11 + 2) >>> 0;
    deltaCycles++;
  }
  // BICS
  else if (opcode >> 6 === 0b0100001110) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const result = (regs.r[Rdn] &= ~regs.r[Rm]);
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
    }
  }
  // BKPT
  else if (opcode >> 8 === 0b10111110) {
    const imm8 = opcode & 0xff;
    core.breakRewind = 2;
    core.onBreak?.(imm8);
  }
  // BL — Thumb-32 wide (0b11110 + 0b11x01x); handled in execute-thumb32.ts,
  // but the M0+ decoder used a single-half check that we must not match here.
  // BLX (register)
  else if (opcode >> 7 === 0b010001111 && (opcode & 0x7) === 0) {
    const Rm = (opcode >> 3) & 0xf;
    regs.lr = (regs.pc | 0x1) >>> 0;
    regs.pc = (regs.r[Rm] & ~1) >>> 0;
    deltaCycles++;
    core.blTaken(core, true);
  }
  // BX
  else if (opcode >> 7 === 0b010001110 && (opcode & 0x7) === 0) {
    const Rm = (opcode >> 3) & 0xf;
    bxWritePC(core, regs.r[Rm]);
    deltaCycles++;
  }
  // CBZ / CBNZ (M33-only Thumb-16; UNDEFINED on M0+)
  // Encoding T1: 1011 x0i1 iiiii Rnnnn  where bit 11 distinguishes CBZ (0)/CBNZ (1).
  // Offset = sign-extended (i:imm5 << 1) added to PC (already at opcodePC + 2).
  else if ((opcode & 0xf500) === 0xb100) {
    const Rn = opcode & 0x7;
    const imm5 = (opcode >> 3) & 0x1f;
    const i = (opcode >> 9) & 0x1;
    const nonzero = (opcode & 0x0800) !== 0;
    const offset = ((i << 6) | (imm5 << 3)) >>> 0;
    void offset;
    const imm = (i << 6) | (imm5 << 1);
    const take = nonzero ? regs.r[Rn] !== 0 : regs.r[Rn] === 0;
    if (take) {
      regs.pc = (regs.pc + imm + 2) >>> 0;
      // (the +2 reflects that PC at this point is opcodePC+2 per ARM ARM.)
      void imm;
      deltaCycles++;
    }
  }
  // CMN (register)
  else if (opcode >> 6 === 0b0100001011) {
    const Rm = (opcode >> 3) & 0x7;
    const Rn = opcode & 0x7;
    addFlags(core, regs.r[Rn], regs.r[Rm]);
  }
  // CMP immediate
  else if (opcode >> 11 === 0b00101) {
    const Rn = (opcode >> 8) & 0x7;
    const imm8 = opcode & 0xff;
    subFlags(core, regs.r[Rn], imm8);
  }
  // CMP (register, low)
  else if (opcode >> 6 === 0b0100001010) {
    const Rm = (opcode >> 3) & 0x7;
    const Rn = opcode & 0x7;
    subFlags(core, regs.r[Rn], regs.r[Rm]);
  }
  // CMP (register, T2 — high registers)
  else if (opcode >> 8 === 0b01000101) {
    const Rm = (opcode >> 3) & 0xf;
    const Rn = ((opcode >> 4) & 0x8) | (opcode & 0x7);
    subFlags(core, regs.r[Rn], regs.r[Rm]);
  }
  // CPS — M33 supports both i (PRIMASK) and f (FAULTMASK).
  // Encoding: 1011 0110 011 i/f 0 0 0
  else if ((opcode & 0xffe8) === 0xb660) {
    // Encoding T1: 1011 0110 011 im 0 A I F — im=bit 4 (0=CPSIE, 1=CPSID),
    // I(PRIMASK)=bit 1, F(FAULTMASK)=bit 0. Bit 2 (A) is not used on M-profile.
    const enable = (opcode & 0x10) === 0; // im (bit 4): 0=IE, 1=ID
    const affectFault = (opcode & 0x1) !== 0; // F (bit 0)
    const affectPrimask = (opcode & 0x2) !== 0; // I (bit 1)
    // CPSIE clears the mask (interrupts enabled); CPSID sets it (masked).
    if (affectPrimask) {
      regs.primask = enable ? 0 : 1;
      core.interruptsUpdated = true;
    }
    if (affectFault) {
      regs.faultmask = enable ? 0 : 1;
      core.interruptsUpdated = true;
    }
  }
  // EORS
  else if (opcode >> 6 === 0b0100000001) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const result = (regs.r[Rm] ^ regs.r[Rdn]) >>> 0;
    regs.r[Rdn] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
    }
  }
  // IT — load IT state. The instruction itself does no execute work; the
  // caller's dispatch loop applies the cond per subsequent instruction.
  // Encoding: 1011 1111 firstcond[3:0] mask[3:0]
  else if (opcode >> 8 === 0xbf) {
    if ((opcode & 0xf) !== 0) {
      // Real IT instruction.
      regs.itState = opcode & 0xff;
    } else {
      // NOP (bf00), YIELD (bf10), WFE (bf20), WFI (bf30), SEV (bf40).
      handleHint(core, opcode);
    }
  }
  // LDMIA
  else if (opcode >> 11 === 0b11001) {
    const Rn = (opcode >> 8) & 0x7;
    const regList = opcode & 0xff;
    let address = regs.r[Rn];
    for (let i = 0; i < 8; i++) {
      if (regList & (1 << i)) {
        regs.r[i] = readU32(core, address);
        address += 4;
        deltaCycles++;
      }
    }
    if (!(regList & (1 << Rn))) {
      regs.r[Rn] = address >>> 0;
    }
  }
  // LDR (immediate)
  else if (opcode >> 11 === 0b01101) {
    const imm5 = ((opcode >> 6) & 0x1f) << 2;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rn] + imm5) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = core.readUint32Unaligned(addr);
  }
  // LDR (sp + immediate)
  else if (opcode >> 11 === 0b10011) {
    const Rt = (opcode >> 8) & 0x7;
    const imm8 = opcode & 0xff;
    const addr = (regs.sp + (imm8 << 2)) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = core.readUint32Unaligned(addr);
  }
  // LDR (literal)
  else if (opcode >> 11 === 0b01001) {
    const imm8 = (opcode & 0xff) << 2;
    const Rt = (opcode >> 8) & 7;
    const nextPC = (regs.pc + 2) >>> 0;
    const addr = ((nextPC & 0xfffffffc) + imm8) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = core.readUint32Unaligned(addr);
  }
  // LDR (register)
  else if (opcode >> 9 === 0b0101100) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = core.readUint32Unaligned(addr);
  }
  // LDRB (immediate)
  else if (opcode >> 11 === 0b01111) {
    const imm5 = (opcode >> 6) & 0x1f;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rn] + imm5) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = readU8(core, addr);
  }
  // LDRB (register)
  else if (opcode >> 9 === 0b0101110) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = readU8(core, addr);
  }
  // LDRH (immediate)
  else if (opcode >> 11 === 0b10001) {
    const imm5 = (opcode >> 6) & 0x1f;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rn] + (imm5 << 1)) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = core.readUint16Unaligned(addr);
  }
  // LDRH (register)
  else if (opcode >> 9 === 0b0101101) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = core.readUint16Unaligned(addr);
  }
  // LDRSB
  else if (opcode >> 9 === 0b0101011) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = signExtend8(readU8(core, addr)) >>> 0;
  }
  // LDRSH
  else if (opcode >> 9 === 0b0101111) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const addr = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, addr);
    regs.r[Rt] = signExtend16(core.readUint16Unaligned(addr)) >>> 0;
  }
  // LSLS (immediate)
  else if (opcode >> 11 === 0b00000) {
    const imm5 = (opcode >> 6) & 0x1f;
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    const input = regs.r[Rm];
    const result = (input << imm5) >>> 0;
    regs.r[Rd] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
      regs.C = imm5 ? (input & (1 << (32 - imm5))) !== 0 : regs.C;
    }
  }
  // LSLS (register)
  else if (opcode >> 6 === 0b0100000010) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const input = regs.r[Rdn];
    const shiftCount = regs.r[Rm] & 0xff;
    let result: number;
    let carry: boolean;
    if (shiftCount === 0) {
      result = input;
      carry = regs.C;
    } else if (shiftCount < 32) {
      result = (input << shiftCount) >>> 0;
      carry = ((input >>> (32 - shiftCount)) & 0x1) !== 0;
    } else if (shiftCount === 32) {
      result = 0;
      carry = (input & 0x1) !== 0;
    } else {
      result = 0;
      carry = false;
    }
    regs.r[Rdn] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
      regs.C = carry;
    }
  }
  // LSRS (immediate)
  else if (opcode >> 11 === 0b00001) {
    const imm5 = (opcode >> 6) & 0x1f;
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    const input = regs.r[Rm];
    const result = imm5 ? input >>> imm5 : 0;
    regs.r[Rd] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
      regs.C = ((input >>> (imm5 ? imm5 - 1 : 31)) & 0x1) !== 0;
    }
  }
  // LSRS (register)
  else if (opcode >> 6 === 0b0100000011) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const shiftAmount = regs.r[Rm] & 0xff;
    const input = regs.r[Rdn];
    let result: number;
    let carry: boolean;
    if (shiftAmount === 0) {
      result = input;
      carry = regs.C;
    } else if (shiftAmount < 32) {
      result = input >>> shiftAmount;
      carry = ((input >>> (shiftAmount - 1)) & 0x1) !== 0;
    } else if (shiftAmount === 32) {
      result = 0;
      carry = input >>> 31 !== 0;
    } else {
      result = 0;
      carry = false;
    }
    regs.r[Rdn] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
      regs.C = carry;
    }
  }
  // MOV (high register, T1)
  else if (opcode >> 8 === 0b01000110) {
    const Rm = (opcode >> 3) & 0xf;
    const Rd = ((opcode >> 4) & 0x8) | (opcode & 0x7);
    const value = Rm === pcRegister ? regs.pc + 2 : regs.r[Rm];
    if (Rd === pcRegister) {
      // MOV PC must handle EXC_RETURN (same as BX/POP) per ARMv8-M §B1.5.2.
      bxWritePC(core, value >>> 0);
      deltaCycles++;
    } else if (Rd === spRegister) {
      regs.r[Rd] = (value & ~3) >>> 0;
    } else {
      regs.r[Rd] = value >>> 0;
    }
  }
  // MOVS
  else if (opcode >> 11 === 0b00100) {
    const value = opcode & 0xff;
    const Rd = (opcode >> 8) & 7;
    regs.r[Rd] = value;
    if (!inItBlock) {
      regs.N = (value & 0x80000000) !== 0;
      regs.Z = value === 0;
    }
  }
  // MULS
  else if (opcode >> 6 === 0b0100001101) {
    const Rn = (opcode >> 3) & 0x7;
    const Rdm = opcode & 0x7;
    const result = Math.imul(regs.r[Rn] | 0, regs.r[Rdm] | 0);
    regs.r[Rdm] = result >>> 0;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = (result & 0xffffffff) === 0;
    }
  }
  // MVNS
  else if (opcode >> 6 === 0b0100001111) {
    const Rm = (opcode >> 3) & 7;
    const Rd = opcode & 7;
    const result = ~regs.r[Rm] >>> 0;
    regs.r[Rd] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
    }
  }
  // ORRS (Encoding T2)
  else if (opcode >> 6 === 0b0100001100) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const result = (regs.r[Rdn] | regs.r[Rm]) >>> 0;
    regs.r[Rdn] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = (result & 0xffffffff) === 0;
    }
  }
  // POP
  else if (opcode >> 9 === 0b1011110) {
    const P = (opcode >> 8) & 1;
    let address = regs.sp;
    for (let i = 0; i <= 7; i++) {
      if (opcode & (1 << i)) {
        regs.r[i] = readU32(core, address);
        address += 4;
        deltaCycles++;
      }
    }
    if (P) {
      const newSp = (address + 4) >>> 0;
      const poppedPc = readU32(core, address);
      // sp must be updated to its final (fully popped) value *before*
      // bxWritePC — if the popped value is an EXC_RETURN pattern,
      // exceptionReturn() syncs regs.msp/psp from the *current* regs.sp
      // (registers.ts syncSpToBanked), and it must see the post-pop value,
      // not the stale one from partway through unstacking. Getting this
      // backwards corrupts the exception frame's computed address by
      // exactly the size of the registers popped before PC, causing the
      // unstacked return PC (and R0-R3/R12/LR) to be read from the wrong
      // location.
      regs.sp = newSp;
      bxWritePC(core, poppedPc);
      deltaCycles += 2;
    } else {
      regs.sp = address >>> 0;
    }
  }
  // PUSH
  else if (opcode >> 9 === 0b1011010) {
    let bitCount = 0;
    for (let i = 0; i <= 8; i++) {
      if (opcode & (1 << i)) bitCount++;
    }
    let address = regs.sp - 4 * bitCount;
    for (let i = 0; i <= 7; i++) {
      if (opcode & (1 << i)) {
        core.chip.writeUint32(address, regs.r[i]);
        deltaCycles++;
        address += 4;
      }
    }
    if (opcode & (1 << 8)) {
      core.chip.writeUint32(address, regs.lr);
    }
    regs.sp = (regs.sp - 4 * bitCount) >>> 0;
  }
  // REV
  else if (opcode >> 6 === 0b1011101000) {
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    const input = regs.r[Rm];
    regs.r[Rd] =
      (((input & 0xff) << 24) |
        (((input >> 8) & 0xff) << 16) |
        (((input >> 16) & 0xff) << 8) |
        ((input >> 24) & 0xff)) >>>
      0;
  }
  // REV16
  else if (opcode >> 6 === 0b1011101001) {
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    const input = regs.r[Rm];
    regs.r[Rd] =
      ((((input >> 16) & 0xff) << 24) |
        (((input >> 24) & 0xff) << 16) |
        ((input & 0xff) << 8) |
        ((input >> 8) & 0xff)) >>>
      0;
  }
  // REVSH
  else if (opcode >> 6 === 0b1011101011) {
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    const input = regs.r[Rm];
    regs.r[Rd] = signExtend16(((input & 0xff) << 8) | ((input >> 8) & 0xff)) >>> 0;
  }
  // ROR
  else if (opcode >> 6 === 0b0100000111) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    const input = regs.r[Rdn];
    const shift = regs.r[Rm] & 0xff;
    let result: number;
    let carry: boolean;
    if (shift === 0) {
      result = input;
      carry = regs.C;
    } else {
      const eff = shift & 31;
      if (eff === 0) {
        result = input;
        carry = input >>> 31 !== 0;
      } else {
        result = ((input >>> eff) | (input << (32 - eff))) >>> 0;
        carry = result >>> 31 !== 0;
      }
    }
    regs.r[Rdn] = result;
    if (!inItBlock) {
      regs.N = (result & 0x80000000) !== 0;
      regs.Z = result === 0;
      regs.C = carry;
    }
  }
  // NEGS / RSBS
  else if (opcode >> 6 === 0b0100001001) {
    const Rn = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = subFlags(core, 0, regs.r[Rn], !inItBlock);
  }
  // NOP (explicit encoding; bf00 handled by IT arm above)
  else if (opcode === 0x46c0) {
    // 46c0 is NOP alias (MOV r8,r8) on some tools.
  }
  // SBCS (Encoding T1)
  else if (opcode >> 6 === 0b0100000110) {
    const Rm = (opcode >> 3) & 0x7;
    const Rdn = opcode & 0x7;
    regs.r[Rdn] = subFlags(core, regs.r[Rdn], regs.r[Rm] + (1 - (regs.C ? 1 : 0)), !inItBlock);
  }
  // SEV — falls through IT arm above (bf40)
  // STMIA
  else if (opcode >> 11 === 0b11000) {
    const Rn = (opcode >> 8) & 0x7;
    const regList = opcode & 0xff;
    let address = regs.r[Rn];
    for (let i = 0; i < 8; i++) {
      if (regList & (1 << i)) {
        core.chip.writeUint32(address, regs.r[i]);
        address += 4;
        deltaCycles++;
      }
    }
    if (!(regList & (1 << Rn))) {
      regs.r[Rn] = address >>> 0;
    }
  }
  // STR (immediate)
  else if (opcode >> 11 === 0b01100) {
    const imm5 = ((opcode >> 6) & 0x1f) << 2;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const address = (regs.r[Rn] + imm5) >>> 0;
    deltaCycles += cyclesIO(core, address, true);
    core.writeUint32Unaligned(address, regs.r[Rt]);
  }
  // STR (sp + immediate)
  else if (opcode >> 11 === 0b10010) {
    const Rt = (opcode >> 8) & 0x7;
    const imm8 = opcode & 0xff;
    const address = (regs.sp + (imm8 << 2)) >>> 0;
    deltaCycles += cyclesIO(core, address, true);
    core.writeUint32Unaligned(address, regs.r[Rt]);
  }
  // STR (register)
  else if (opcode >> 9 === 0b0101000) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const address = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, address, true);
    core.writeUint32Unaligned(address, regs.r[Rt]);
  }
  // STRB (immediate)
  else if (opcode >> 11 === 0b01110) {
    const imm5 = (opcode >> 6) & 0x1f;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const address = (regs.r[Rn] + imm5) >>> 0;
    deltaCycles += cyclesIO(core, address, true);
    core.chip.writeUint8(address, regs.r[Rt]);
  }
  // STRB (register)
  else if (opcode >> 9 === 0b0101010) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const address = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, address, true);
    core.chip.writeUint8(address, regs.r[Rt]);
  }
  // STRH (immediate)
  else if (opcode >> 11 === 0b10000) {
    const imm5 = ((opcode >> 6) & 0x1f) << 1;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const address = (regs.r[Rn] + imm5) >>> 0;
    deltaCycles += cyclesIO(core, address, true);
    core.writeUint16Unaligned(address, regs.r[Rt]);
  }
  // STRH (register)
  else if (opcode >> 9 === 0b0101001) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rt = opcode & 0x7;
    const address = (regs.r[Rm] + regs.r[Rn]) >>> 0;
    deltaCycles += cyclesIO(core, address, true);
    core.writeUint16Unaligned(address, regs.r[Rt]);
  }
  // SUB (SP minus immediate)
  else if (opcode >> 7 === 0b101100001) {
    const imm32 = (opcode & 0x7f) << 2;
    regs.sp = (regs.sp - imm32) >>> 0;
  }
  // SUBS (Encoding T1)
  else if (opcode >> 9 === 0b0001111) {
    const imm3 = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = subFlags(core, regs.r[Rn], imm3, !inItBlock);
  }
  // SUBS (Encoding T2)
  else if (opcode >> 11 === 0b00111) {
    const imm8 = opcode & 0xff;
    const Rdn = (opcode >> 8) & 0x7;
    regs.r[Rdn] = subFlags(core, regs.r[Rdn], imm8, !inItBlock);
  }
  // SUBS (register)
  else if (opcode >> 9 === 0b0001101) {
    const Rm = (opcode >> 6) & 0x7;
    const Rn = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = subFlags(core, regs.r[Rn], regs.r[Rm], !inItBlock);
  }
  // SVC
  else if (opcode >> 8 === 0b11011111) {
    core.pendingSVCall = true;
    core.interruptsUpdated = true;
  }
  // SXTB
  else if (opcode >> 6 === 0b1011001001) {
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = signExtend8(regs.r[Rm]) >>> 0;
  }
  // SXTH
  else if (opcode >> 6 === 0b1011001000) {
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = signExtend16(regs.r[Rm]) >>> 0;
  }
  // TST
  else if (opcode >> 6 === 0b0100001000) {
    const Rm = (opcode >> 3) & 0x7;
    const Rn = opcode & 0x7;
    const result = regs.r[Rn] & regs.r[Rm];
    regs.N = (result & 0x80000000) !== 0;
    regs.Z = result === 0;
  }
  // UDF
  else if (opcode >> 8 === 0b11011110) {
    const imm8 = opcode & 0xff;
    core.breakRewind = 2;
    core.onBreak?.(imm8);
  }
  // UXTB
  else if (opcode >> 6 === 0b1011001011) {
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = regs.r[Rm] & 0xff;
  }
  // UXTH
  else if (opcode >> 6 === 0b1011001010) {
    const Rm = (opcode >> 3) & 0x7;
    const Rd = opcode & 0x7;
    regs.r[Rd] = regs.r[Rm] & 0xffff;
  }
  // Anything else: deferred to Thumb-32 or unimplemented.
  else {
    return -1; // sentinel: caller should try Thumb-32.
  }

  return deltaCycles;
}

/**
 * BX/POP-PC write to PC: detect EXC_RETURN magic and trigger exception return
 * when in Handler mode. Per ARMv8-M §B1.5.2, EXC_RETURN has bits [31:24]=0xff.
 */
function bxWritePC(core: CortexM33Core, address: number) {
  if (core.regs.inHandlerMode() && address >>> 24 === 0xff) {
    core.exceptionReturn(address & 0x0fffffff);
  } else {
    core.regs.pc = (address & ~1) >>> 0;
  }
}

/** Handle NOP / YIELD / WFE / WFI / SEV hint encodings. */
function handleHint(core: CortexM33Core, opcode: number) {
  switch (opcode & 0xff) {
    case 0x00: // NOP
      return;
    case 0x10: // YIELD
      return;
    case 0x20: // WFE
      if (core.eventRegistered) {
        core.eventRegistered = false;
      } else {
        core.waiting = true;
      }
      return;
    case 0x30: // WFI
      core.waiting = true;
      return;
    case 0x40: // SEV
      core.fireSEV();
      return;
    default:
      return;
  }
}

/** Exported for the dispatch loop. */
export { advanceItState, bxWritePC };
