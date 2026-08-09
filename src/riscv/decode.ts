/**
 * Pre-decoded RISC-V instruction representation.
 *
 * Every instruction decodes to one packed Int53 value:
 *   low 32 bits:  tag(8) | rs2(5) | rs1(5) | rd(5) | length(1) | reserved(8)
 *   high 21 bits: raw immediate (masked to 21 bits, sign-extended at use time)
 *
 * Extraction: low 32 via `packed >>> 0`, high 21 via `int53High(packed)`.
 * Sign extension at execution time is pure bitwise: `(imm << shift) >> shift`.
 *
 * Compressed forms map to the SAME tags as their 32-bit equivalents.
 */

import { Int53, int53Pack } from '../utils/types';

const TAG_SHIFT = 24;
const RS2_SHIFT = 19;
const RS1_SHIFT = 14;
const RD_SHIFT = 9;
const LEN_SHIFT = 8;
const LEN_32 = 1 << LEN_SHIFT;
const LEN_16 = 0;

function emit(
  tag: number,
  rd: number,
  rs1: number,
  rs2: number,
  imm: number,
  length: number
): Int53 {
  const low =
    ((tag << TAG_SHIFT) | (rd << RD_SHIFT) | (rs1 << RS1_SHIFT) | (rs2 << RS2_SHIFT) | length) >>>
    0;
  return int53Pack(low, imm & 0x1fffff);
}

// ─── Tag values ───────────────────────────────────────────────────
export const T_INVALID = 0;
export const T_LB = 1,
  T_LH = 2,
  T_LW = 3,
  T_LBU = 4,
  T_LHU = 5,
  T_FENCE = 6;
export const T_ADDI = 7,
  T_SLLI = 8,
  T_BSETI = 9,
  T_BCLRI = 10,
  T_BINVI = 11;
export const T_CTZ = 12,
  T_CPOP = 13,
  T_SEXT_H = 14,
  T_SEXT_B = 15,
  T_CLZ = 16;
export const T_ZIP = 17,
  T_UNZIP = 18,
  T_SLTI = 19,
  T_SLTIU = 20,
  T_XORI = 21;
export const T_ORI = 22,
  T_ANDI = 23,
  T_SRLI = 24,
  T_SRAI = 25,
  T_BEXTI = 26;
export const T_RORI = 27,
  T_REV8 = 28,
  T_BREV8 = 29,
  T_ORC_B = 30,
  T_ZEXT_H = 31;
export const T_SB = 32,
  T_SH = 33,
  T_SW = 34;
export const T_LR_W = 35,
  T_SC_W = 36;
export const T_AMOADD_W = 37,
  T_AMOSWAP_W = 38,
  T_AMOXOR_W = 39,
  T_AMOOR_W = 40;
export const T_AMOAND_W = 41,
  T_AMOMIN_W = 42,
  T_AMOMAX_W = 43,
  T_AMOMINU_W = 44,
  T_AMOMAXU_W = 45;
export const T_ADD = 46,
  T_SUB = 47,
  T_MUL = 48,
  T_SLL = 49,
  T_MULH = 50;
export const T_BSET = 51,
  T_BCLR = 52,
  T_ROL = 53,
  T_BINV = 54,
  T_SLT = 55;
export const T_MULHSU = 56,
  T_SH1ADD = 57,
  T_SLTU = 58,
  T_MULHU = 59,
  T_XOR = 60;
export const T_DIV = 61,
  T_SH2ADD = 62,
  T_PACK = 63,
  T_MIN = 64,
  T_XNOR = 65;
export const T_SRL = 66,
  T_MINU = 67,
  T_SRA = 68,
  T_BEXT = 69,
  T_ROR = 70;
export const T_DIVU = 71,
  T_OR = 72,
  T_REM = 73,
  T_MAX = 74,
  T_ORN = 75;
export const T_SH3ADD = 76,
  T_AND = 77,
  T_ANDN = 78,
  T_PACKH = 79,
  T_MAXU = 80;
export const T_REMU = 81,
  T_H3_BLOCK = 82,
  T_H3_UNBLOCK = 83;
export const T_LUI = 84,
  T_AUIPC = 85;
export const T_BEQ = 86,
  T_BNE = 87,
  T_BLT = 88,
  T_BGE = 89,
  T_BLTU = 90,
  T_BGEU = 91;
export const T_JALR = 92,
  T_JAL = 93;
export const T_MRET = 94,
  T_ECALL = 95,
  T_EBREAK = 96,
  T_WFI = 97;
export const T_CSRRW = 98,
  T_CSRRS = 99,
  T_CSRRC = 100;
export const T_CSRWI = 101,
  T_CSRRSI = 102,
  T_CSRRCI = 103;
export const T_H3_BEXTM = 104,
  T_H3_BEXTMI = 105;
export const T_CM_PUSH = 106,
  T_CM_POP = 107,
  T_CM_POPRETZ = 108,
  T_CM_POPRET = 109;
export const T_CM_MVSA01 = 110,
  T_CM_MVA01S = 111;

// ─── 32-bit field extractors ────────────────────────────────────────
const opcode = (i: number) => i & 0x7f;
const rd = (i: number) => (i >>> 7) & 0x1f;
const func3 = (i: number) => (i >>> 12) & 0x7;
const rs1 = (i: number) => (i >>> 15) & 0x1f;
const rs2 = (i: number) => (i >>> 20) & 0x1f;
const func7 = (i: number) => (i >>> 25) & 0x7f;
const shamt = (i: number) => (i >>> 20) & 0x1f;

// Raw immediates — sign extension happens at execution time.
const imm_i = (i: number) => (i >> 20) & 0x1fffff; // I-type, 12-bit signed → 21-bit
const immU_i = (i: number) => (i >>> 20) & 0xfff; // I-type, raw 12-bit unsigned
const imm_s = (i: number) => (((i >> 25) << 5) | ((i >>> 7) & 0x1f)) & 0x1fffff;
const imm_b = (i: number) =>
  (((i >> 31) << 12) |
    (((i >>> 7) & 1) << 11) |
    (((i >>> 25) & 0x3f) << 5) |
    (((i >>> 8) & 0xf) << 1)) &
  0x1fffff;
const imm_u = (i: number) => (i >>> 12) & 0x1fffff; // U-type, raw 20-bit (execution does << 12)
const imm_j = (i: number) =>
  (((i >> 31) << 20) |
    (((i >>> 12) & 0xff) << 12) |
    (((i >>> 20) & 1) << 11) |
    (((i >>> 21) & 0x3ff) << 1)) &
  0x1fffff;

export function decodeWord(word: number): Int53 {
  if ((word & 3) !== 3) return decodeCompressed(word & 0xffff);
  return decodeStandard(word);
}

function decodeStandard(inst: number): Int53 {
  const op = opcode(inst),
    f3 = func3(inst),
    r = rd(inst),
    s1 = rs1(inst),
    s2 = rs2(inst);
  switch (op) {
    case 0x03:
      switch (f3) {
        case 0x0:
          return emit(T_LB, r, s1, 0, imm_i(inst), LEN_32);
        case 0x1:
          return emit(T_LH, r, s1, 0, imm_i(inst), LEN_32);
        case 0x2:
          return emit(T_LW, r, s1, 0, imm_i(inst), LEN_32);
        case 0x4:
          return emit(T_LBU, r, s1, 0, imm_i(inst), LEN_32);
        case 0x5:
          return emit(T_LHU, r, s1, 0, imm_i(inst), LEN_32);
        default:
          throw Error(`Invalid LOAD func3 ${f3}`);
      }
    case 0x0f:
      return emit(T_FENCE, 0, 0, 0, 0, LEN_32);
    case 0x13: {
      const sh = shamt(inst),
        f7 = func7(inst),
        imu = immU_i(inst);
      switch (f3) {
        case 0x0:
          return emit(T_ADDI, r, s1, 0, imm_i(inst), LEN_32);
        case 0x1:
          if (f7 === 0x00) return emit(T_SLLI, r, s1, 0, sh, LEN_32);
          if (f7 === 0x14) return emit(T_BSETI, r, s1, 0, sh, LEN_32);
          if (f7 === 0x24) return emit(T_BCLRI, r, s1, 0, sh, LEN_32);
          if (f7 === 0x34) return emit(T_BINVI, r, s1, 0, sh, LEN_32);
          if (imu === 0b011000000001) return emit(T_CTZ, r, s1, 0, 0, LEN_32);
          if (imu === 0b011000000010) return emit(T_CPOP, r, s1, 0, 0, LEN_32);
          if (imu === 0b011000000101) return emit(T_SEXT_H, r, s1, 0, 0, LEN_32);
          if (imu === 0b011000000100) return emit(T_SEXT_B, r, s1, 0, 0, LEN_32);
          if ((inst & 0b11111111111100000111000001111111) === 0b01100000000000000001000000010011)
            return emit(T_CLZ, r, s1, 0, 0, LEN_32);
          if (imu === 0b000010001111) return emit(T_ZIP, r, s1, 0, 0, LEN_32);
          throw Error(`Unknown OP-IMM func3=1, func7: 0x${f7.toString(16)}`);
        case 0x2:
          return emit(T_SLTI, r, s1, 0, imm_i(inst), LEN_32);
        case 0x3:
          return emit(T_SLTIU, r, s1, 0, imm_i(inst), LEN_32);
        case 0x4:
          return emit(T_XORI, r, s1, 0, imm_i(inst), LEN_32);
        case 0x5:
          if (f7 === 0x00) return emit(T_SRLI, r, s1, 0, sh, LEN_32);
          if (f7 === 0x20) return emit(T_SRAI, r, s1, 0, sh, LEN_32);
          if (f7 === 0x24) return emit(T_BEXTI, r, s1, 0, sh, LEN_32);
          if (f7 === 0x30) return emit(T_RORI, r, s1, 0, sh, LEN_32);
          if (imu === 0x698) return emit(T_REV8, r, s1, 0, 0, LEN_32);
          if (imu === 0x687) return emit(T_BREV8, r, s1, 0, 0, LEN_32);
          if (imu === 0x287) return emit(T_ORC_B, r, s1, 0, 0, LEN_32);
          if (imu === 0b000010001111) return emit(T_UNZIP, r, s1, 0, 0, LEN_32);
          throw Error(`Unknown OP-IMM func3=5, func7: 0x${f7.toString(16)}`);
        case 0x6:
          return emit(T_ORI, r, s1, 0, imm_i(inst), LEN_32);
        case 0x7:
          return emit(T_ANDI, r, s1, 0, imm_i(inst), LEN_32);
        default:
          throw Error(`Invalid OP-IMM func3 ${f3}`);
      }
    }
    case 0x17:
      return emit(T_AUIPC, r, 0, 0, imm_u(inst), LEN_32);
    case 0x23:
      switch (f3) {
        case 0x0:
          return emit(T_SB, 0, s1, s2, imm_s(inst), LEN_32);
        case 0x1:
          return emit(T_SH, 0, s1, s2, imm_s(inst), LEN_32);
        case 0x2:
          return emit(T_SW, 0, s1, s2, imm_s(inst), LEN_32);
        default:
          throw Error(`Invalid STORE func3 ${f3}`);
      }
    case 0x2f: {
      if (f3 !== 0x2) throw Error(`Invalid AMO func3 ${f3}`);
      const funct5 = (inst >>> 27) & 0x1f;
      switch (funct5) {
        case 0x02:
          return emit(T_LR_W, r, s1, 0, 0, LEN_32);
        case 0x03:
          return emit(T_SC_W, r, s1, s2, 0, LEN_32);
        case 0x00:
          return emit(T_AMOADD_W, r, s1, s2, 0, LEN_32);
        case 0x01:
          return emit(T_AMOSWAP_W, r, s1, s2, 0, LEN_32);
        case 0x04:
          return emit(T_AMOXOR_W, r, s1, s2, 0, LEN_32);
        case 0x08:
          return emit(T_AMOOR_W, r, s1, s2, 0, LEN_32);
        case 0x0c:
          return emit(T_AMOAND_W, r, s1, s2, 0, LEN_32);
        case 0x10:
          return emit(T_AMOMIN_W, r, s1, s2, 0, LEN_32);
        case 0x14:
          return emit(T_AMOMAX_W, r, s1, s2, 0, LEN_32);
        case 0x18:
          return emit(T_AMOMINU_W, r, s1, s2, 0, LEN_32);
        case 0x1c:
          return emit(T_AMOMAXU_W, r, s1, s2, 0, LEN_32);
        default:
          throw Error(`Unknown AMO funct5: 0x${funct5.toString(16)}`);
      }
    }
    case 0x33: {
      const f7 = func7(inst);
      switch (f3) {
        case 0x0:
          if (f7 === 0x00) return emit(T_ADD, r, s1, s2, 0, LEN_32);
          if (f7 === 0x20) return emit(T_SUB, r, s1, s2, 0, LEN_32);
          if (f7 === 0x01) return emit(T_MUL, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=0, func7: 0x${f7.toString(16)}`);
        case 0x1:
          if (f7 === 0x00) return emit(T_SLL, r, s1, s2, 0, LEN_32);
          if (f7 === 0x01) return emit(T_MULH, r, s1, s2, 0, LEN_32);
          if (f7 === 0x14) return emit(T_BSET, r, s1, s2, 0, LEN_32);
          if (f7 === 0x24) return emit(T_BCLR, r, s1, s2, 0, LEN_32);
          if (f7 === 0x30) return emit(T_ROL, r, s1, s2, 0, LEN_32);
          if (f7 === 0x34) return emit(T_BINV, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=1, func7: 0x${f7.toString(16)}`);
        case 0x2:
          if (f7 === 0x00) {
            if (r === 0 && s1 === 0) {
              if (s2 === 0) return emit(T_H3_BLOCK, 0, 0, 0, 0, LEN_32);
              if (s2 === 1) return emit(T_H3_UNBLOCK, 0, 0, 0, 0, LEN_32);
            }
            return emit(T_SLT, r, s1, s2, 0, LEN_32);
          }
          if (f7 === 0x01) return emit(T_MULHSU, r, s1, s2, 0, LEN_32);
          if (f7 === 0x10) return emit(T_SH1ADD, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=2, func7: 0x${f7.toString(16)}`);
        case 0x3:
          if (f7 === 0x00) return emit(T_SLTU, r, s1, s2, 0, LEN_32);
          if (f7 === 0x01) return emit(T_MULHU, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=3, func7: 0x${f7.toString(16)}`);
        case 0x4:
          if (f7 === 0x00) return emit(T_XOR, r, s1, s2, 0, LEN_32);
          if (f7 === 0x01) return emit(T_DIV, r, s1, s2, 0, LEN_32);
          if (f7 === 0x10) return emit(T_SH2ADD, r, s1, s2, 0, LEN_32);
          if (f7 === 0x04) return emit(T_PACK, r, s1, s2, 0, LEN_32);
          if (f7 === 0x05) return emit(T_MIN, r, s1, s2, 0, LEN_32);
          if (f7 === 0x20) return emit(T_XNOR, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=4, func7: 0x${f7.toString(16)}`);
        case 0x5:
          if (f7 === 0x00) return emit(T_SRL, r, s1, s2, 0, LEN_32);
          if (f7 === 0x05) return emit(T_MINU, r, s1, s2, 0, LEN_32);
          if (f7 === 0x20) return emit(T_SRA, r, s1, s2, 0, LEN_32);
          if (f7 === 0x24) return emit(T_BEXT, r, s1, s2, 0, LEN_32);
          if (f7 === 0x30) return emit(T_ROR, r, s1, s2, 0, LEN_32);
          if (f7 === 0x01) return emit(T_DIVU, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=5, func7: 0x${f7.toString(16)}`);
        case 0x6:
          if (f7 === 0x00) return emit(T_OR, r, s1, s2, 0, LEN_32);
          if (f7 === 0x01) return emit(T_REM, r, s1, s2, 0, LEN_32);
          if (f7 === 0x05) return emit(T_MAX, r, s1, s2, 0, LEN_32);
          if (f7 === 0x20) return emit(T_ORN, r, s1, s2, 0, LEN_32);
          if (f7 === 0x10) return emit(T_SH3ADD, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=6, func7: 0x${f7.toString(16)}`);
        case 0x7:
          if (f7 === 0x00) return emit(T_AND, r, s1, s2, 0, LEN_32);
          if (f7 === 0x20) return emit(T_ANDN, r, s1, s2, 0, LEN_32);
          if (f7 === 0x04) return emit(T_PACKH, r, s1, s2, 0, LEN_32);
          if (f7 === 0x05) return emit(T_MAXU, r, s1, s2, 0, LEN_32);
          if (f7 === 0x01) return emit(T_REMU, r, s1, s2, 0, LEN_32);
          throw Error(`Unknown OP func3=7, func7: 0x${f7.toString(16)}`);
        default:
          throw Error(`Invalid OP func3 ${f3}`);
      }
    }
    case 0x37:
      return emit(T_LUI, r, 0, 0, imm_u(inst), LEN_32);
    case 0x63:
      switch (f3) {
        case 0x0:
          return emit(T_BEQ, 0, s1, s2, imm_b(inst), LEN_32);
        case 0x1:
          return emit(T_BNE, 0, s1, s2, imm_b(inst), LEN_32);
        case 0x4:
          return emit(T_BLT, 0, s1, s2, imm_b(inst), LEN_32);
        case 0x5:
          return emit(T_BGE, 0, s1, s2, imm_b(inst), LEN_32);
        case 0x6:
          return emit(T_BLTU, 0, s1, s2, imm_b(inst), LEN_32);
        case 0x7:
          return emit(T_BGEU, 0, s1, s2, imm_b(inst), LEN_32);
        default:
          throw Error(`Invalid BRANCH func3 ${f3}`);
      }
    case 0x67:
      if (f3 !== 0) throw Error(`Invalid JALR func3 ${f3}`);
      return emit(T_JALR, r, s1, 0, imm_i(inst), LEN_32);
    case 0x6f:
      return emit(T_JAL, r, 0, 0, imm_j(inst), LEN_32);
    case 0x73: {
      switch (f3) {
        case 0x0:
          switch (inst >>> 0) {
            case 0x30200073:
              return emit(T_MRET, 0, 0, 0, 0, LEN_32);
            case 0x73:
              return emit(T_ECALL, 0, 0, 0, 0, LEN_32);
            case 0x100073:
              return emit(T_EBREAK, 0, 0, 0, 0, LEN_32);
            case 0x10500073:
              return emit(T_WFI, 0, 0, 0, 0, LEN_32);
            default:
              throw Error(`Unknown SYSTEM instruction 0x${(inst >>> 0).toString(16)}`);
          }
        case 0x1:
          return emit(T_CSRRW, r, s1, 0, immU_i(inst), LEN_32);
        case 0x2:
          return emit(T_CSRRS, r, s1, 0, immU_i(inst), LEN_32);
        case 0x3:
          return emit(T_CSRRC, r, s1, 0, immU_i(inst), LEN_32);
        case 0x5: {
          const imm5 = rs1(inst);
          return emit(T_CSRWI, r, 0, 0, (immU_i(inst) << 5) | imm5, LEN_32);
        }
        case 0x6: {
          const imm5 = rs1(inst);
          return emit(T_CSRRSI, r, 0, 0, (immU_i(inst) << 5) | imm5, LEN_32);
        }
        case 0x7: {
          const imm5 = rs1(inst);
          return emit(T_CSRRCI, r, 0, 0, (immU_i(inst) << 5) | imm5, LEN_32);
        }
        default:
          throw Error(`Invalid SYSTEM func3 ${f3}`);
      }
    }
    case 0x0b: {
      const c_ident = inst & 0b11100010000000000111000001111111;
      const size = (inst >>> 26) & 0b111;
      const immWithSize = size << 1;
      if (c_ident === 0b00000000000000000000000000001011)
        return emit(T_H3_BEXTM, r, s1, s2, immWithSize, LEN_32);
      if (c_ident === 0b00000000000000000100000000001011)
        return emit(T_H3_BEXTMI, r, s1, s2, immWithSize, LEN_32);
      throw Error(`Invalid CUSTOM0 instruction 0x${inst.toString(16)}`);
    }
    default:
      throw Error(`Invalid instruction: 0x${inst.toString(16)}, opcode 0x${op.toString(16)}`);
  }
}

// ─── Compressed decode ─────────────────────────────────────────────
function decodeCompressed(inst: number): Int53 {
  if (inst === 0) throw Error(`Illegal 16 bit instruction 0`);
  switch (inst & 3) {
    case 0:
      return decodeC0(inst);
    case 1:
      return decodeC1(inst);
    case 2:
      return decodeC2(inst);
  }
  throw new Error(`Unsupported compressed instruction: 0x${inst.toString(16)}`);
}

const C_CI_MASK_12 = 0x1000,
  C_CI_MASK_6_4 = 0x70,
  C_CI_MASK_3_2 = 0xc;
const C_CSS_IMM_5_2 = 0x1e00,
  C_CSS_IMM_7_6 = 0x180;
const C_CIW_IMM_5_4 = 0x1800,
  C_CIW_IMM_9_6 = 0x780,
  C_CIW_IMM_3 = 0x20,
  C_CIW_IMM_2 = 0x40;
const C_CLWSW_IMM_5_3 = 0x1c00,
  C_CLWSW_IMM_2 = 0x40,
  C_CLWSW_IMM_6 = 0x20;
const C_CB_OFFSET_8 = 0x1000,
  C_CB_OFFSET_4_3 = 0xc00,
  C_CB_OFFSET_7_6 = 0x60;
const C_CB_OFFSET_2_1 = 0x18,
  C_CB_OFFSET_5 = 0x4;
const C_CJ_OFFSET_11 = 0x1000,
  C_CJ_OFFSET_4 = 0x800,
  C_CJ_OFFSET_9_8 = 0x600;
const C_CJ_OFFSET_10 = 0x100,
  C_CJ_OFFSET_6 = 0x80,
  C_CJ_OFFSET_7 = 0x40;
const C_CJ_OFFSET_3_1 = 0x38,
  C_CJ_OFFSET_5 = 0x4;

function dec_rd(inst: number): number {
  return (inst & 0xf80) >> 7;
}
function dec_rs2(inst: number): number {
  return (inst & 0x7c) >> 2;
}
function dec_rd_short(inst: number): number {
  return ((inst & 0x1c) >> 2) | 0b1000;
}
function dec_rs1_short(inst: number): number {
  return ((inst & 0x380) >> 7) | 0b1000;
}
function dec_rs2_short(inst: number): number {
  return ((inst & 0x1c) >> 2) | 0b1000;
}

function sign_extend(x: number, sign_position: number): number {
  const sign = (x >> sign_position) & 1;
  let r = x;
  for (let i = sign_position + 1; i < 32; ++i) r |= sign << i;
  return r;
}

function decodeC0(inst: number): Int53 {
  switch ((inst >> 13) & 7) {
    case 0: {
      let nzuimm = 0;
      nzuimm |= (inst & C_CIW_IMM_9_6) >> 1;
      nzuimm |= (inst & C_CIW_IMM_5_4) >> 7;
      nzuimm |= (inst & C_CIW_IMM_3) >> 2;
      nzuimm |= (inst & C_CIW_IMM_2) >> 4;
      return emit(T_ADDI, dec_rd_short(inst), 2, 0, nzuimm & 0x1fffff, LEN_16);
    }
    case 2: {
      let imm = 0;
      imm |= (inst & C_CLWSW_IMM_6) << 1;
      imm |= (inst & C_CLWSW_IMM_5_3) >> 7;
      imm |= (inst & C_CLWSW_IMM_2) >> 4;
      return emit(T_LW, dec_rd_short(inst), dec_rs1_short(inst), 0, imm, LEN_16);
    }
    case 4: {
      const base = dec_rs1_short(inst);
      const sub = (inst >>> 10) & 0b111;
      switch (sub) {
        case 0b000: {
          const uimm = (((inst >>> 5) & 1) << 1) | ((inst >>> 6) & 1);
          return emit(T_LBU, dec_rd_short(inst), base, 0, uimm, LEN_16);
        }
        case 0b001: {
          const uimm = ((inst >>> 5) & 1) << 1;
          return emit((inst >>> 6) & 1 ? T_LH : T_LHU, dec_rd_short(inst), base, 0, uimm, LEN_16);
        }
        case 0b010: {
          const uimm = (((inst >>> 5) & 1) << 1) | ((inst >>> 6) & 1);
          return emit(T_SB, 0, base, dec_rs2_short(inst), uimm, LEN_16);
        }
        case 0b011: {
          if ((inst >>> 6) & 1) break;
          const uimm = ((inst >>> 5) & 1) << 1;
          return emit(T_SH, 0, base, dec_rs2_short(inst), uimm, LEN_16);
        }
      }
      break;
    }
    case 6: {
      let imm = 0;
      imm |= (inst & C_CLWSW_IMM_6) << 1;
      imm |= (inst & C_CLWSW_IMM_5_3) >> 7;
      imm |= (inst & C_CLWSW_IMM_2) >> 4;
      return emit(T_SW, 0, dec_rs1_short(inst), dec_rs2_short(inst), imm, LEN_16);
    }
  }
  throw new Error(`Unsupported compressed instruction: 0x${inst.toString(16)}`);
}

function decodeC1(inst: number): Int53 {
  switch ((inst >> 13) & 7) {
    case 0: {
      const r = dec_rd(inst);
      let nzimm = 0;
      nzimm |= (inst & C_CI_MASK_12) >> 7;
      nzimm |= (inst & (C_CI_MASK_6_4 | C_CI_MASK_3_2)) >> 2;
      nzimm = sign_extend(nzimm, 5);
      return emit(T_ADDI, r, r, 0, nzimm & 0x1fffff, LEN_16);
    }
    case 1:
      return emit(T_JAL, 1, 0, 0, decCjImm(inst) & 0x1fffff, LEN_16);
    case 2: {
      const r = dec_rd(inst);
      let imm = 0;
      imm |= (inst & C_CI_MASK_12) >> 7;
      imm |= (inst & (C_CI_MASK_6_4 | C_CI_MASK_3_2)) >> 2;
      imm = sign_extend(imm, 5);
      return emit(T_ADDI, r, 0, 0, imm & 0x1fffff, LEN_16);
    }
    case 3: {
      const r = dec_rd(inst);
      if (r === 2) {
        let nzimm = 0;
        nzimm |= (inst & 0x1000) >> 3;
        nzimm |= (inst & 0x0018) << 4;
        nzimm |= (inst & 0x0020) << 1;
        nzimm |= (inst & 0x0004) << 3;
        nzimm |= (inst & 0x0040) >> 2;
        nzimm = sign_extend(nzimm, 9);
        return emit(T_ADDI, 2, 2, 0, nzimm & 0x1fffff, LEN_16);
      } else {
        // C.LUI: nzimm assembled in bits[17:12], sign-extended. Store raw 20-bit
        // (value >>> 12) to match 32-bit LUI's imm_u format; execution does imm << 12.
        let nzimm = 0;
        nzimm |= (inst & C_CI_MASK_12) << 5;
        nzimm |= (inst & (C_CI_MASK_6_4 | C_CI_MASK_3_2)) << 10;
        nzimm = sign_extend(nzimm, 17);
        return emit(T_LUI, r, 0, 0, (nzimm >>> 12) & 0x1fffff, LEN_16);
      }
    }
    case 4: {
      const cb_funct2 = (inst & 0xc00) >> 10;
      const cs_funct6_3_funct2 =
        (((((inst & 0xfc00) >> 10) >>> 2) & 1) << 2) | ((inst & 0x60) >> 5);
      switch (cb_funct2) {
        case 0b00: {
          let sh = 0;
          sh |= (inst & C_CI_MASK_12) >> 7;
          sh |= (inst & (C_CI_MASK_6_4 | C_CI_MASK_3_2)) >> 2;
          return emit(T_SRLI, dec_rs1_short(inst), dec_rs1_short(inst), 0, sh, LEN_16);
        }
        case 0b01: {
          let sh = 0;
          sh |= (inst & C_CI_MASK_12) >> 7;
          sh |= (inst & (C_CI_MASK_6_4 | C_CI_MASK_3_2)) >> 2;
          return emit(T_SRAI, dec_rs1_short(inst), dec_rs1_short(inst), 0, sh, LEN_16);
        }
        case 0b10: {
          let imm = 0;
          imm |= (inst & C_CI_MASK_12) >> 7;
          imm |= (inst & (C_CI_MASK_6_4 | C_CI_MASK_3_2)) >> 2;
          imm = sign_extend(imm, 5);
          return emit(T_ANDI, dec_rs1_short(inst), dec_rs1_short(inst), 0, imm & 0x1fffff, LEN_16);
        }
        case 0b11:
          switch (cs_funct6_3_funct2) {
            case 0b000:
              return emit(
                T_SUB,
                dec_rs1_short(inst),
                dec_rs1_short(inst),
                dec_rs2_short(inst),
                0,
                LEN_16
              );
            case 0b001:
              return emit(
                T_XOR,
                dec_rs1_short(inst),
                dec_rs1_short(inst),
                dec_rs2_short(inst),
                0,
                LEN_16
              );
            case 0b010:
              return emit(
                T_OR,
                dec_rs1_short(inst),
                dec_rs1_short(inst),
                dec_rs2_short(inst),
                0,
                LEN_16
              );
            case 0b011:
              return emit(
                T_AND,
                dec_rs1_short(inst),
                dec_rs1_short(inst),
                dec_rs2_short(inst),
                0,
                LEN_16
              );
            case 0b110:
              return emit(
                T_MUL,
                dec_rs1_short(inst),
                dec_rs1_short(inst),
                dec_rs2_short(inst),
                0,
                LEN_16
              );
            case 0b111: {
              const r = dec_rs1_short(inst);
              switch ((inst >>> 2) & 0b111) {
                case 0b000:
                  return emit(T_ANDI, r, r, 0, 0xff, LEN_16); // c.zext.b
                case 0b001:
                  return emit(T_SEXT_B, r, r, 0, 0, LEN_16);
                case 0b010:
                  return emit(T_ZEXT_H, r, r, 0, 0, LEN_16); // c.zext.h
                case 0b011:
                  return emit(T_SEXT_H, r, r, 0, 0, LEN_16);
                case 0b101:
                  return emit(T_XORI, r, r, 0, -1 & 0x1fffff, LEN_16); // c.not → xori -1
              }
              return emit(T_INVALID, 0, 0, 0, 0, LEN_16);
            }
          }
          break;
      }
      break;
    }
    case 5:
      return emit(T_JAL, 0, 0, 0, decCjImm(inst) & 0x1fffff, LEN_16);
    case 6:
      return emit(T_BEQ, 0, dec_rs1_short(inst), 0, decBranchImm(inst) & 0x1fffff, LEN_16);
    case 7:
      return emit(T_BNE, 0, dec_rs1_short(inst), 0, decBranchImm(inst) & 0x1fffff, LEN_16);
  }
  throw new Error(`Unsupported compressed instruction: 0x${inst.toString(16)}`);
}

function decodeC2(inst: number): Int53 {
  switch ((inst >> 13) & 7) {
    case 0: {
      let shamt = 0;
      shamt |= (inst & C_CI_MASK_12) >> 7;
      shamt |= (inst & (C_CI_MASK_6_4 | C_CI_MASK_3_2)) >> 2;
      const r = dec_rd(inst);
      return emit(T_SLLI, r, r, 0, shamt, LEN_16);
    }
    case 2: {
      let offset = 0;
      offset |= (inst & C_CI_MASK_12) >> 7;
      offset |= (inst & C_CI_MASK_6_4) >> 2;
      offset |= (inst & C_CI_MASK_3_2) << 4;
      return emit(T_LW, dec_rd(inst), 2, 0, offset, LEN_16);
    }
    case 4: {
      const cr_funct4 = (inst & 0xf000) >> 12;
      const rs1v = (inst & 0xf80) >> 7;
      const rs2v = (inst & 0x7c) >> 2;
      if (cr_funct4 === 0b1000) {
        if (rs2v === 0) return emit(T_JALR, 0, rs1v, 0, 0, LEN_16);
        return emit(T_ADD, dec_rd(inst), 0, rs2v, 0, LEN_16);
      } else if (cr_funct4 === 0b1001) {
        if (rs1v === 0 && rs2v === 0) return emit(T_EBREAK, 0, 0, 0, 0, LEN_16);
        else if (rs2v === 0) return emit(T_JALR, 1, rs1v, 0, 0, LEN_16);
        return emit(T_ADD, dec_rd(inst), dec_rd(inst), rs2v, 0, LEN_16);
      }
      return emit(T_ADDI, 0, 0, 0, 0, LEN_16);
    }
    case 5: {
      const masked = inst & 0b1111111100000011;
      if (masked === 0b1011100000000010) {
        const rlist = (inst & 0b11110000) >>> 4;
        return emit(T_CM_PUSH, 0, 0, rlist, (inst & 0b1100) << 2, LEN_16);
      }
      if (masked === 0b1011101000000010) {
        const rlist = (inst & 0b11110000) >>> 4;
        return emit(T_CM_POP, 0, 0, rlist, (inst & 0b1100) << 2, LEN_16);
      }
      if (masked === 0b1011110000000010) {
        const rlist = (inst & 0b11110000) >>> 4;
        return emit(T_CM_POPRETZ, 0, 0, rlist, (inst & 0b1100) << 2, LEN_16);
      }
      if (masked === 0b1011111000000010) {
        const rlist = (inst & 0b11110000) >>> 4;
        return emit(T_CM_POPRET, 0, 0, rlist, (inst & 0b1100) << 2, LEN_16);
      }
      const masked2 = inst & 0b1111110001100011;
      if (masked2 === 0b1010110000100010) {
        const r1s = 8 + ((inst >>> 7) & 1);
        const r2s = 8 + ((inst >>> 2) & 1);
        return emit(T_CM_MVSA01, r1s, r2s, 10, 11, LEN_16);
      }
      if (masked2 === 0b1010110001100010) {
        const r1s = 8 + ((inst >>> 7) & 1);
        const r2s = 8 + ((inst >>> 2) & 1);
        return emit(T_CM_MVA01S, 10, 11, r1s, r2s, LEN_16);
      }
      break;
    }
    case 6: {
      let offset = 0;
      offset |= (inst & C_CSS_IMM_7_6) >> 1;
      offset |= (inst & C_CSS_IMM_5_2) >> 7;
      return emit(T_SW, 0, 2, dec_rs2(inst), offset, LEN_16);
    }
  }
  throw new Error(`Unsupported compressed instruction: 0x${inst.toString(16)}`);
}

function decCjImm(inst: number): number {
  let imm = 0;
  imm |= (inst & C_CJ_OFFSET_11) >> 1;
  imm |= (inst & C_CJ_OFFSET_10) << 2;
  imm |= (inst & C_CJ_OFFSET_9_8) >> 1;
  imm |= (inst & C_CJ_OFFSET_7) << 1;
  imm |= (inst & C_CJ_OFFSET_6) >> 1;
  imm |= (inst & C_CJ_OFFSET_5) << 3;
  imm |= (inst & C_CJ_OFFSET_4) >> 7;
  imm |= (inst & C_CJ_OFFSET_3_1) >> 2;
  return sign_extend(imm, 11);
}

function decBranchImm(inst: number): number {
  let imm = 0;
  imm |= (inst & C_CB_OFFSET_8) >> 4;
  imm |= (inst & C_CB_OFFSET_7_6) << 1;
  imm |= (inst & C_CB_OFFSET_5) << 3;
  imm |= (inst & C_CB_OFFSET_4_3) >> 7;
  imm |= (inst & C_CB_OFFSET_2_1) >> 2;
  return sign_extend(imm, 8);
}
