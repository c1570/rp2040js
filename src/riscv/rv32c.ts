import { CPU, checkTraceMagic } from './cpu';

export function executeRv32c(cpu: CPU, inst: number): void {
  switch (inst & 3) {
    case 0:
      switch ((inst >> 13) & 7) {
        case 0:
          caddi4spn(cpu, inst);
          return;
        case 2:
          clw(cpu, inst);
          return;
        case 4:
          zcb_100_00(cpu, inst);
          return;
        case 6:
          csw(cpu, inst);
          return;
      }
      break;
    case 1:
      switch ((inst >> 13) & 7) {
        case 0:
          caddi(cpu, inst);
          return;
        case 1:
          cjal(cpu, inst);
          return;
        case 2:
          cli(cpu, inst);
          return;
        case 3:
          parse_011_01(cpu, inst);
          return;
        case 4:
          parse_100_01(cpu, inst);
          return;
        case 5:
          cj(cpu, inst);
          return;
        case 6:
          cbeqz(cpu, inst);
          return;
        case 7:
          cbenz(cpu, inst);
          return;
      }
      break;
    case 2:
      switch ((inst >> 13) & 7) {
        case 0:
          cslli(cpu, inst);
          return;
        case 2:
          clwsp(cpu, inst);
          return;
        case 4:
          parse_100_10(cpu, inst);
          return;
        case 5:
          parse_101_10(cpu, inst);
          return;
        case 6:
          cswsp(cpu, inst);
          return;
      }
      break;
  }
  throw new Error(`Unsupported compressed instruction: 0x${inst.toString(16)}`);
}

function assert(a: boolean) {}

// C.ADDI4SPN, funct3 = 000, opcode = 00
function caddi4spn(cpu: CPU, inst: number): void {
  // addi rd', x2, nzuimm
  const nzuimm = dec_ciw_imm(inst);
  const rd = dec_rd_short(inst);
  cpu.setRegisterU(rd, (cpu.getRegisterU(2) + nzuimm) >>> 0);
}

// C.LW, funct3 = 010, opcode = 00
function clw(cpu: CPU, inst: number): void {
  // lw rd', imm(rs1')
  const imm = dec_clw_csw_imm(inst);
  const rs1 = dec_rs1_short(inst);
  const rd = dec_rd_short(inst);
  const addr = cpu.getRegisterU(rs1) + imm;
  cpu.setRegisterU(rd, cpu.chip.readUint32(addr));
}

// Zcb extension, funct3 = 100, opcode = 00. Sub-op in bits[12:10]
function zcb_100_00(cpu: CPU, inst: number): void {
  const base = cpu.getRegisterU(dec_rs1_short(inst));
  const sub = (inst >>> 10) & 0b111;
  switch (sub) {
    case 0b000: {
      // c.lbu
      const uimm = (((inst >>> 5) & 1) << 1) | ((inst >>> 6) & 1);
      const rd = dec_rd_short(inst);
      cpu.setRegister(rd, cpu.chip.readUint8(base + uimm));
      return;
    }
    case 0b001: {
      const uimm = ((inst >>> 5) & 1) << 1;
      const rd = dec_rd_short(inst);
      const half = cpu.chip.readUint16(base + uimm);
      if ((inst >>> 6) & 1) cpu.setRegister(rd, sign_extend(half, 15)); // c.lh
      else cpu.setRegister(rd, half); // c.lhu
      return;
    }
    case 0b010: {
      // c.sb
      const uimm = (((inst >>> 5) & 1) << 1) | ((inst >>> 6) & 1);
      const rs2 = dec_rs2_short(inst);
      cpu.chip.writeUint8(base + uimm, cpu.getRegister(rs2) & 0xff);
      return;
    }
    case 0b011: {
      if ((inst >>> 6) & 1) break;
      // c.sh
      const uimm = ((inst >>> 5) & 1) << 1;
      const rs2 = dec_rs2_short(inst);
      cpu.chip.writeUint16(base + uimm, cpu.getRegister(rs2) & 0xffff);
      return;
    }
  }
  throw Error(`Unsupported Zcb instruction: 0x${inst.toString(16)}`);
}

// C.SW, funct3 = 110, opcode = 00
function csw(cpu: CPU, inst: number): void {
  // sw rs2', imm(rs1')
  const imm = dec_clw_csw_imm(inst);
  const rs1 = dec_rs1_short(inst);
  const rs2 = dec_rs2_short(inst);
  cpu.chip.writeUint32(cpu.getRegisterU(rs1) + imm, cpu.getRegister(rs2));
}

function cnop(): void {
  // no-op
}

// C.ADDI, funct3 = 000, opcode = 01
function caddi(cpu: CPU, inst: number): void {
  // addi rd, rd, nzimm
  const rd = dec_rd(inst);
  let nzimm = 0;
  nzimm |= (inst & C.CI_MASK_12) >> 7;
  nzimm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
  nzimm = sign_extend(nzimm, 5);
  if (nzimm === 0) return; // HINT
  cpu.setRegisterU(rd, (cpu.getRegisterU(rd) + nzimm) >>> 0);
}

// C.JAL, funct3 = 001, opcode = 01
function cjal(cpu: CPU, inst: number): void {
  // jal x1, imm — ra = pc+2, jump to pc+imm
  checkTraceMagic(cpu, cpu.pc + 2);
  cpu.setRegister(1, cpu.pc + 2);
  cpu.next_pc = cpu.pc + dec_cj_imm(inst);
  cpu.cycles++;
}

// C.LI, funct3 = 010, opcode = 01
function cli(cpu: CPU, inst: number): void {
  // addi rd, x0, imm (li)
  const rd = dec_rd(inst);
  let imm = 0;
  imm |= (inst & C.CI_MASK_12) >> 7;
  imm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
  imm = sign_extend(imm, 5);
  if (rd === 0) return; // HINT
  cpu.setRegister(rd, imm);
}

// C.ADDI16SP, funct3 = 011, opcode = 01
function caddi16sp(cpu: CPU, inst: number): void {
  // addi x2, x2, nzimm
  let nzimm = 0;
  nzimm |= (inst & 0x1000) >> 3;
  nzimm |= (inst & 0x0018) << 4;
  nzimm |= (inst & 0x0020) << 1;
  nzimm |= (inst & 0x0004) << 3;
  nzimm |= (inst & 0x0040) >> 2;
  nzimm = sign_extend(nzimm, 9);
  assert(nzimm !== 0);
  cpu.setRegisterU(2, (cpu.getRegisterU(2) + nzimm) >>> 0);
}

// C.LUI, funct3 = 011, opcode = 01
function clui(cpu: CPU, inst: number): void {
  // lui rd, nzimm
  const rd = dec_rd(inst);
  let nzimm = 0;
  nzimm |= (inst & C.CI_MASK_12) << 5;
  nzimm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) << 10;
  nzimm = sign_extend(nzimm, 17);
  assert(nzimm !== 0);
  if (rd === 0) return; // HINT
  cpu.setRegisterU(rd, nzimm);
}

function csrli(cpu: CPU, inst: number): void {
  // srli rd', rd', shamt
  let shamt = 0;
  shamt |= (inst & C.CI_MASK_12) >> 7;
  assert(shamt === 0); // shamt[5] must be zero for RV32C
  shamt |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
  assert(shamt !== 0);
  const rd = dec_rs1_short(inst);
  cpu.setRegister(rd, cpu.getRegister(rd) >>> shamt);
}

function csrai(cpu: CPU, inst: number): void {
  // srai rd', rd', shamt
  let shamt = 0;
  shamt |= (inst & C.CI_MASK_12) >> 7;
  assert(shamt === 0);
  shamt |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
  assert(shamt !== 0);
  const rd = dec_rs1_short(inst);
  cpu.setRegister(rd, cpu.getRegister(rd) >> shamt);
}

function candi(cpu: CPU, inst: number): void {
  // andi rd', rd', imm
  const rd = dec_rs1_short(inst);
  let imm = 0;
  imm |= (inst & C.CI_MASK_12) >> 7;
  imm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
  imm = sign_extend(imm, 5);
  cpu.setRegister(rd, cpu.getRegister(rd) & imm);
}

function csub(cpu: CPU, inst: number): void {
  // sub rd', rd', rs2'
  const rd = dec_rs1_short(inst);
  const rs2 = dec_rs2_short(inst);
  cpu.setRegister(rd, cpu.getRegister(rd) - cpu.getRegister(rs2));
}

function cxor(cpu: CPU, inst: number): void {
  const rd = dec_rs1_short(inst);
  const rs2 = dec_rs2_short(inst);
  cpu.setRegister(rd, cpu.getRegister(rd) ^ cpu.getRegister(rs2));
}

function cor(cpu: CPU, inst: number): void {
  const rd = dec_rs1_short(inst);
  const rs2 = dec_rs2_short(inst);
  cpu.setRegister(rd, cpu.getRegister(rd) | cpu.getRegister(rs2));
}

function cand(cpu: CPU, inst: number): void {
  const rd = dec_rs1_short(inst);
  const rs2 = dec_rs2_short(inst);
  cpu.setRegister(rd, cpu.getRegister(rd) & cpu.getRegister(rs2));
}

// C.J, funct3 = 101, opcode = 01
function cj(cpu: CPU, inst: number): void {
  // jal x0, imm (jump, no link)
  checkTraceMagic(cpu, cpu.pc + 2);
  cpu.next_pc = cpu.pc + dec_cj_imm(inst);
  cpu.cycles++;
}

// C.BEQZ, funct3 = 110, opcode = 01
function cbeqz(cpu: CPU, inst: number): void {
  // beq rs1', x0, offset
  const offset = dec_branch_imm(inst);
  const rs1 = dec_rs1_short(inst);
  const taken = cpu.getRegister(rs1) === 0;
  if (taken) cpu.next_pc = cpu.pc + offset;
  cpu.h3_branch_cycles(taken);
}

// C.BENZ, funct3 = 111, opcode = 01
function cbenz(cpu: CPU, inst: number): void {
  // bne rs1', x0, offset
  const offset = dec_branch_imm(inst);
  const rs1 = dec_rs1_short(inst);
  const taken = cpu.getRegister(rs1) !== 0;
  if (taken) cpu.next_pc = cpu.pc + offset;
  cpu.h3_branch_cycles(taken);
}

// C.SLLI, funct3 = 000, opcode = 10
function cslli(cpu: CPU, inst: number): void {
  // slli rd, rd, shamt
  let shamt = 0;
  shamt |= (inst & C.CI_MASK_12) >> 7;
  assert(shamt === 0);
  shamt |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
  assert(shamt !== 0);
  const rd = dec_rd(inst);
  if (rd === 0) return; // HINT
  cpu.setRegisterU(rd, cpu.getRegisterU(rd) << shamt);
}

// C.LWSP, funct3 = 010, opcode = 10
function clwsp(cpu: CPU, inst: number): void {
  // lw rd, offset(x2)
  let offset = 0;
  offset |= (inst & C.CI_MASK_12) >> 7;
  offset |= (inst & C.CI_MASK_6_4) >> 2;
  offset |= (inst & C.CI_MASK_3_2) << 4;
  const rd = dec_rd(inst);
  assert(rd !== 0);
  const addr = cpu.getRegisterU(2) + offset;
  cpu.setRegisterU(rd, cpu.chip.readUint32(addr));
}

function cjr(cpu: CPU, inst: number): void {
  // jalr x0, rs1, 0 (jump to rs1, no link)
  const rs1 = dec_rs1(inst);
  assert(rs1 !== 0);
  cpu.next_pc = cpu.getRegister(rs1);
  cpu.cycles++;
}

function cmv(cpu: CPU, inst: number): void {
  // add rd, x0, rs2 (mv)
  const rs2 = dec_rs2(inst);
  assert(rs2 !== 0);
  const rd = dec_rd(inst);
  if (rd === 0) return; // HINT
  cpu.setRegister(rd, cpu.getRegister(rs2));
}

function cebreak(cpu: CPU): void {
  // ebreak — trap with mcause=3
  cpu.trapEntry(3, true);
}

function cjalr(cpu: CPU, inst: number): void {
  // jalr x1, rs1, 0 (call)
  const rs1 = dec_rs1(inst);
  assert(rs1 !== 0);
  cpu.setRegister(1, cpu.pc + 2);
  cpu.next_pc = cpu.getRegister(rs1);
  cpu.cycles++;
}

function cadd(cpu: CPU, inst: number): void {
  // add rd, rd, rs2
  const rs2 = dec_rs2(inst);
  assert(rs2 !== 0);
  const rd = dec_rd(inst);
  if (rd === 0) return; // HINT
  cpu.setRegister(rd, cpu.getRegister(rd) + cpu.getRegister(rs2));
}

// C.SWSP, funct3 = 110, opcode = 10
function cswsp(cpu: CPU, inst: number): void {
  // sw rs2, offset(x2)
  const offset = dec_css_imm(inst);
  const rs2 = dec_rs2(inst);
  const addr = cpu.getRegisterU(2) + offset;
  cpu.chip.writeUint32(addr, cpu.getRegister(rs2));
}

// funct3 = 011, opcode = 01
function parse_011_01(cpu: CPU, inst: number): void {
  const rd: number = dec_rd(inst);

  if (rd == 2) caddi16sp(cpu, inst);
  else clui(cpu, inst);
}

// funct3 = 100, opcode = 01
function parse_100_01(cpu: CPU, inst: number): void {
  const cb_funct2: number = dec_cb_funct2(inst);
  const cs_funct6_3_funct2: number = (((dec_cs_funct6(inst) >>> 2) & 1) << 2) | dec_cs_funct2(inst);

  // Actual lookup order: funct3, xlen, rdRs1Val, cb_funct2, funct6[3]+funct2
  switch (cb_funct2) {
    case 0b00:
      csrli(cpu, inst);
      return;
    case 0b01:
      csrai(cpu, inst);
      return;
    case 0b10:
      candi(cpu, inst);
      return;
    case 0b11:
      switch (cs_funct6_3_funct2) {
        case 0b000:
          csub(cpu, inst);
          return;
        case 0b001:
          cxor(cpu, inst);
          return;
        case 0b010:
          cor(cpu, inst);
          return;
        case 0b011:
          cand(cpu, inst);
          return;
        case 0b110: {
          // c.mul (Zcb): mul rd', rd', rs2'
          const rd = dec_rs1_short(inst);
          const rs2 = dec_rs2_short(inst);
          cpu.setRegister(rd, (cpu.getRegister(rd) * cpu.getRegister(rs2)) & 0xffffffff);
          return;
        }
        case 0b111: {
          // Zcb unary ops, sub-op in bits[4:2]
          const rd = dec_rs1_short(inst);
          switch ((inst >>> 2) & 0b111) {
            case 0b000: // c.zext.b -> andi rd, rd, 0xff
              cpu.setRegister(rd, cpu.getRegister(rd) & 0xff);
              return;
            case 0b001: // c.sext.b -> sext.b rd, rd
              cpu.setRegister(rd, sign_extend(cpu.getRegisterU(rd) & 0xff, 7));
              return;
            case 0b010: // c.zext.h -> zext.h rd, rd (pack rd, rd, x0)
              cpu.setRegister(rd, cpu.getRegisterU(rd) & 0xffff);
              return;
            case 0b011: // c.sext.h -> sext.h rd, rd
              cpu.setRegister(rd, sign_extend(cpu.getRegisterU(rd) & 0xffff, 15));
              return;
            case 0b101: // c.not -> xori rd, rd, -1
              cpu.setRegister(rd, ~cpu.getRegister(rd));
              return;
          }
          return;
        }
      }
  }
  throw Error(`Unknown compressed instruction: 0x${inst.toString(16)}`);
}

// funct3 = 100, opcode = 10
function parse_100_10(cpu: CPU, inst: number): void {
  const cr_funct4: number = dec_cr_funct4(inst);
  const rs1: number = dec_rs1(inst);
  const rs2: number = dec_rs2(inst);

  if (cr_funct4 == 0b1000) {
    if (rs2 == 0) cjr(cpu, inst);
    else cmv(cpu, inst);
  } else if (cr_funct4 == 0b1001) {
    if (rs1 == 0 && rs2 == 0) cebreak(cpu);
    else if (rs2 == 0) cjalr(cpu, inst);
    else cadd(cpu, inst);
  } else cnop();
}

const xreg_list = [
  [],
  [],
  [],
  [],
  [1],
  [8, 1],
  [9, 8, 1],
  [18, 9, 8, 1],
  [19, 18, 9, 8, 1],
  [20, 19, 18, 9, 8, 1],
  [21, 20, 19, 18, 9, 8, 1],
  [22, 21, 20, 19, 18, 9, 8, 1],
  [23, 22, 21, 20, 19, 18, 9, 8, 1],
  [24, 23, 22, 21, 20, 19, 18, 9, 8, 1],
  [25, 24, 23, 22, 21, 20, 19, 18, 9, 8, 1],
  [27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 9, 8, 1],
];
const stack_adj_base = [0, 0, 0, 0, 16, 16, 16, 16, 32, 32, 32, 32, 48, 48, 48, 64];

function parse_101_10(cpu: CPU, inst: number): void {
  switch (inst & 0b1111111100000011) {
    case 0b1011100000000010: {
      // cm.push (Zcmp)
      const rlist = (inst & 0b11110000) >>> 4;
      const spimm = (inst & 0b1100) << 2;
      const stack_adj = stack_adj_base[rlist] + spimm;
      const sp = cpu.getRegisterU(2);
      let addr = sp - 4;
      for (let reg of xreg_list[rlist]) {
        cpu.chip.writeUint32(addr, cpu.getRegisterU(reg));
        addr -= 4;
        cpu.cycles++;
      }
      cpu.setRegisterU(2, sp - stack_adj);
      return;
    }
    case 0b1011101000000010: {
      // cm.pop (Zcmp) — load registers, adjust SP, no return
      const rlist = (inst & 0b11110000) >>> 4;
      const spimm = (inst & 0b1100) << 2;
      const stack_adj = stack_adj_base[rlist] + spimm;
      const sp = cpu.getRegisterU(2);
      let addr = sp + stack_adj - 4;
      for (let reg of xreg_list[rlist]) {
        cpu.setRegisterU(reg, cpu.chip.readUint32(addr));
        addr -= 4;
        cpu.cycles++;
      }
      cpu.setRegisterU(2, sp + stack_adj);
      return;
    }
    case 0b1011110000000010: {
      // cm.popretz (Zcmp) — load registers, adjust SP, clear a0, then ret
      const rlist = (inst & 0b11110000) >>> 4;
      const spimm = (inst & 0b1100) << 2;
      const stack_adj = stack_adj_base[rlist] + spimm;
      const sp = cpu.getRegisterU(2);
      let addr = sp + stack_adj - 4;
      for (let reg of xreg_list[rlist]) {
        cpu.setRegisterU(reg, cpu.chip.readUint32(addr));
        addr -= 4;
        cpu.cycles++;
      }
      cpu.setRegisterU(2, sp + stack_adj);
      cpu.setRegister(10, 0); // li a0, 0
      cpu.next_pc = cpu.getRegister(1); // ret = jalr x0, x1, 0
      cpu.cycles++;
      return;
    }
    case 0b1011111000000010: {
      // cm.popret (Zcmp)
      const rlist = (inst & 0b11110000) >>> 4;
      const spimm = (inst & 0b1100) << 2;
      const stack_adj = stack_adj_base[rlist] + spimm;
      const sp = cpu.getRegisterU(2);
      let addr = sp + stack_adj - 4;
      for (let reg of xreg_list[rlist]) {
        cpu.setRegisterU(reg, cpu.chip.readUint32(addr));
        addr -= 4;
        cpu.cycles++;
      }
      cpu.setRegisterU(2, sp + stack_adj);
      cpu.next_pc = cpu.getRegister(1); // ret = jalr x0, x1, 0
      cpu.cycles++;
      return;
    }
  }
  switch (inst & 0b1111110001100011) {
    case 0b1010110000100010: {
      // cm.mvsa01 r1s, r2s (Zcmp) — s0/s1 <- a0/a1
      const r1s = 8 + ((inst >>> 7) & 1);
      const r2s = 8 + ((inst >>> 2) & 1);
      cpu.setRegister(r1s, cpu.getRegister(10));
      cpu.setRegister(r2s, cpu.getRegister(11));
      return;
    }
    case 0b1010110001100010: {
      // cm.mva01s r1s, r2s (Zcmp) — a0/a1 <- s0/s1
      const r1s = 8 + ((inst >>> 7) & 1);
      const r2s = 8 + ((inst >>> 2) & 1);
      cpu.setRegister(10, cpu.getRegister(r1s));
      cpu.setRegister(11, cpu.getRegister(r2s));
      return;
    }
  }
  throw new Error(`Unsupported instruction: 0x${inst.toString(16)}`);
}

enum C {
  C_RD = 0b0000111110000000, // general
  C_RS1 = 0b0000111110000000,
  C_RS2 = 0b0000000001111100,
  C_RD_S = 0b0000000000011100,
  C_RS1_S = 0b0000001110000000,
  C_RS2_S = 0b0000000000011100,
  CR_FUNCT4 = 0b1111000000000000, // CR-format
  CI_MASK_12 = 0b0001000000000000, // CI-format
  CI_MASK_6_4 = 0b0000000001110000,
  CI_MASK_3_2 = 0b0000000000001100,
  CSS_IMM_5_2 = 0b0001111000000000, // CSS-format
  CSS_IMM_7_6 = 0b0000000110000000,
  CIW_IMM_5_4 = 0b0001100000000000, // CIW-format
  CIW_IMM_9_6 = 0b0000011110000000,
  CIW_IMM_2 = 0b0000000001000000,
  CIW_IMM_3 = 0b0000000000100000,
  CLWSW_IMM_5_3 = 0b0001110000000000, // C.LW, C.SW
  CLWSW_IMM_2 = 0b0000000001000000,
  CLWSW_IMM_6 = 0b0000000000100000,
  CS_FUNCT6 = 0b1111110000000000, // CS-format
  CS_FUNCT2 = 0b0000000001100000,
  CB_FUNCT2 = 0b0000110000000000, // C.SRLI, C.SRAI, C.ANDI
  CB_OFFSET_8 = 0b0001000000000000, // C.BEQZ, C.BNEZ
  CB_OFFSET_4_3 = 0b0000110000000000,
  CB_OFFSET_7_6 = 0b0000000001100000,
  CB_OFFSET_2_1 = 0b0000000000011000,
  CB_OFFSET_5 = 0b0000000000000100,
  CJ_OFFSET_11 = 0b0001000000000000, // CJ-format
  CJ_OFFSET_4 = 0b0000100000000000,
  CJ_OFFSET_9_8 = 0b0000011000000000,
  CJ_OFFSET_10 = 0b0000000100000000,
  CJ_OFFSET_6 = 0b0000000010000000,
  CJ_OFFSET_7 = 0b0000000001000000,
  CJ_OFFSET_3_1 = 0b0000000000111000,
  CJ_OFFSET_5 = 0b0000000000000100,
}
// clang-format off

// decode rd field
function dec_rd(inst: number): number {
  return (inst & C.C_RD) >> 7;
}

// decode rs1 field
function dec_rs1(inst: number): number {
  return (inst & C.C_RS1) >> 7;
}

// decode rs2 field
function dec_rs2(inst: number): number {
  return (inst & C.C_RS2) >> 2;
}

// decode rd' field and return its correspond register
function dec_rd_short(inst: number): number {
  return ((inst & C.C_RD_S) >> 2) | 0b1000;
}

// decode rs1' field and return its correspond register
function dec_rs1_short(inst: number): number {
  return ((inst & C.C_RS1_S) >> 7) | 0b1000;
}

// decode rs2' field and return its correspond register
function dec_rs2_short(inst: number): number {
  return ((inst & C.C_RS2_S) >> 2) | 0b1000;
}

// sign extend from specific position to MSB
function sign_extend(x: number, sign_position: number): number {
  let sign: number = (x >> sign_position) & 1;
  for (let i: number = sign_position + 1; i < 32; ++i) x |= sign << i;
  return x;
}

// decode CR-format instruction funct4 field
function dec_cr_funct4(inst: number): number {
  return (inst & C.CR_FUNCT4) >> 12;
}

// decode CSS-format instruction immediate
function dec_css_imm(inst: number): number {
  // zero-extended offset, scaled by 4
  let imm: number = 0;
  imm |= (inst & C.CSS_IMM_7_6) >> 1;
  imm |= (inst & C.CSS_IMM_5_2) >> 7;
  return imm;
}

// decode CIW-format instruction immediate
function dec_ciw_imm(inst: number): number {
  // zero-extended non-zero immediate, scaled by 4
  let imm: number = 0;
  imm |= (inst & C.CIW_IMM_9_6) >> 1;
  imm |= (inst & C.CIW_IMM_5_4) >> 7;
  imm |= (inst & C.CIW_IMM_3) >> 2;
  imm |= (inst & C.CIW_IMM_2) >> 4;
  assert(imm != 0);
  return imm;
}

// decode immediate of C.LW and C.SW
function dec_clw_csw_imm(inst: number): number {
  // zero-extended offset, scaled by 4
  let imm: number = 0;
  imm |= (inst & C.CLWSW_IMM_6) << 1;
  imm |= (inst & C.CLWSW_IMM_5_3) >> 7;
  imm |= (inst & C.CLWSW_IMM_2) >> 4;
  return imm;
}

// decode CS-format instruction funct6 field
function dec_cs_funct6(inst: number): number {
  return (inst & C.CS_FUNCT6) >> 10;
}

// decode CS-format instruction funct2 field
function dec_cs_funct2(inst: number): number {
  return (inst & C.CS_FUNCT2) >> 5;
}

// decode CB-format instruction funct2 field
function dec_cb_funct2(inst: number): number {
  return (inst & C.CB_FUNCT2) >> 10;
}

// decode immediate of branch instruction
function dec_branch_imm(inst: number): number {
  // sign-extended offset, scaled by 2
  let imm: number = 0;
  imm |= (inst & C.CB_OFFSET_8) >> 4;
  imm |= (inst & C.CB_OFFSET_7_6) << 1;
  imm |= (inst & C.CB_OFFSET_5) << 3;
  imm |= (inst & C.CB_OFFSET_4_3) >> 7;
  imm |= (inst & C.CB_OFFSET_2_1) >> 2;
  imm = sign_extend(imm, 8);
  return imm;
}

// decode CJ-format instruction immediate
function dec_cj_imm(inst: number): number {
  // sign-extended offset, scaled by 2
  let imm: number = 0;
  imm |= (inst & C.CJ_OFFSET_11) >> 1;
  imm |= (inst & C.CJ_OFFSET_10) << 2;
  imm |= (inst & C.CJ_OFFSET_9_8) >> 1;
  imm |= (inst & C.CJ_OFFSET_7) << 1;
  imm |= (inst & C.CJ_OFFSET_6) >> 1;
  imm |= (inst & C.CJ_OFFSET_5) << 3;
  imm |= (inst & C.CJ_OFFSET_4) >> 7;
  imm |= (inst & C.CJ_OFFSET_3_1) >> 2;
  imm = sign_extend(imm, 11);
  return imm;
}
