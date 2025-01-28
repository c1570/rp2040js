import { B_Type, I_Type, Instruction, InstructionType, J_Type, R_Type, S_Type, U_Type } from "./Assembler/instruction";
import { getRange } from "./binaryFunctions";
import { IRPChip } from "../rpchip";
import { decompress_rv32c_inst } from "./rv32c";

export class CPU {

  public onSEV?: () => void;
  public waiting = false;
  public eventRegistered = false;

  registerSet: RegisterSet = new RegisterSet(32);
  pc = 0;
  next_pc = 0;
  stopped = false; //TODO
  cycles = 0;
  mtvec: number = 0;

  constructor(readonly chip: IRPChip, readonly coreLabel: string, readonly mhartid: number) {
  }

  reset() { } //TODO

  setInterrupt(a: any, b: any) { } //TODO

  inst_length = 0;
  private break_after_steps = 100000;

  private fetchInstruction(): number {
    this.break_after_steps--;
    if(this.break_after_steps == 0) throw Error("Ending.");
    let inst = this.chip.readUint16(this.pc);
    if ((inst & 3) != 3) {
        // TODO: filter illegal instruction
        if (inst == 0) {
            console.log(`Illegal 16 bit instruction: ${inst}`);
        }

        inst = decompress_rv32c_inst(inst);
        this.inst_length = 2;
    } else {
        // we have a 32 bit instruction
        inst |= this.chip.readUint16(this.pc + 2) << 16;
        this.inst_length = 4;
    }
    return inst >>> 0;
  }

  executeInstruction() {
    if (this.waiting) {
      this.cycles++;
      return;
    }
    if (this.chip.disassembly) {
      const search = (this.pc.toString(16) + ":").replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const re = new RegExp(search + "(.*)");
      const res = re.exec(this.chip.disassembly);
      const dis = (res == null) ? "?" : res[1];
      console.log(`*** ${this.coreLabel} - PC 0x${this.pc.toString(16)} - ${dis}`);
    } else {
      console.log(`*** ${this.coreLabel} - PC 0x${this.pc.toString(16)}`);
    }
    const instruction = this.fetchInstruction();
    console.log(`executing (decoded) instr 0x${instruction.toString(16)}`);
    this.step(instruction);
    this.cycles++; //TODO
  }

  step(instruction: number) {

    const instructionType = opcodeTypeTable.get(getRange(instruction, 6, 0));

    switch (instructionType as InstructionType) {
      case InstructionType.R:
        this.executeR_Type(new R_Type({ binary: instruction }));
        break;
      case InstructionType.I:
        this.executeI_Type(new I_Type({ binary: instruction }));
        break;
      case InstructionType.S:
        this.executeS_Type(new S_Type({ binary: instruction }));
        break;
      case InstructionType.B:
        this.executeB_Type(new B_Type({ binary: instruction }));
        break;
      case InstructionType.U:
        this.executeU_Type(new U_Type({ binary: instruction }));
        break;
      case InstructionType.J:
        this.executeJ_Type(new J_Type({ binary: instruction }));
        break;
      default:
        throw Error(`Invalid instruction: 0x${instruction.toString(16)} at 0x${this.pc.toString(16)}, OpcodeType 0x${getRange(instruction, 6, 0).toString(16)}`);
        break;
    }

    if(this.next_pc != 0) {
      this.pc = this.next_pc;
      this.next_pc = 0;
    } else {
      this.pc += this.inst_length;
    }

  }

  private executeR_Type(instruction: R_Type) {

    const { opcode, func3 } = instruction;

    // Get func3 lookup table for R_Type instructions
    const funcTable = r_TypeOpcodeTable.get(opcode);

    const operation = funcTable?.get(func3);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      throw Error(`Invalid Instruction opcode 0x${opcode.toString(16)}, func3 ${func3}`);
    }
  }

  private executeI_Type(instruction: I_Type) {
    const { opcode, func3 } = instruction;

    // Get func3 lookup table for I_Type instructions
    const funcTable = i_TypeOpcodeTable.get(opcode);

    const operation = funcTable?.get(func3);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      throw Error(`Invalid Instruction opcode 0x${opcode.toString(16)}, func3 ${func3}`);
    }

  }

  private executeS_Type(instruction: S_Type) {

    const { opcode, func3 } = instruction;

    // Get func3 lookup table for S_Type instructions
    const funcTable = s_TypeOpcodeTable.get(opcode);

    const operation = funcTable?.get(func3);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      throw Error(`Invalid Instruction opcode 0x${opcode.toString(16)}, func3 ${func3}`);
    }
  }

  private executeB_Type(instruction: B_Type) {

    const { opcode, func3 } = instruction;

    // Get func3 lookup table for B_Type instructions
    const funcTable = b_TypeOpcodeTable.get(opcode);

    const operation = funcTable?.get(func3);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      throw Error(`Invalid Instruction opcode 0x${opcode.toString(16)}, func3 ${func3}`);
    }

  }

  private executeU_Type(instruction: U_Type) {
    const { opcode } = instruction;

    // Get lookup table for U_Type instructions
    const operation = u_TypeOpcodeTable.get(opcode);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      throw Error(`Invalid Instruction opcode 0x${opcode.toString(16)}`);
    }
  }

  private executeJ_Type(instruction: J_Type) {
    const { opcode } = instruction;

    // Get lookup table for J_Type instructions
    const operation = j_TypeOpcodeTable.get(opcode);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      throw Error(`Invalid Instruction opcode 0x${opcode.toString(16)}`);
    }
  }

}

function signExtend8(value: number) {
  return (value << 24) >> 24;
}

function signExtend16(value: number) {
  return (value << 16) >> 16;
}

export class RegisterSet {

  private registerBuffer: ArrayBuffer;
  private registerView: DataView;

  constructor(numRegisters: number) {
    this.registerBuffer = new ArrayBuffer(numRegisters * 4);
    this.registerView = new DataView(this.registerBuffer);
  }

  getRegister(index: number): number {
    if (index === 0) {
      return 0;
    }

    return this.registerView.getInt32(index * 4, true);
  }

  getRegisterU(index: number): number {
    if (index === 0) {
      return 0;
    }

    return this.registerView.getUint32(index * 4, true);
  }

  setRegister(index: number, value: number): void {
    if (index === 0) {
      return;
    }

    this.registerView.setInt32(index * 4, value, true);
  }

  setRegisterU(index: number, value: number): void {
    if (index === 0) {
      return;
    }

    this.registerView.setUint32(index * 4, value, true);
  }

}

type OpcodeTable<T extends Instruction> = Map<number, (instruction: T, cpu: CPU) => void>;
type OpcodeFuncTable<T extends Instruction> = Map<number, Map<number, (instruction: T, cpu: CPU) => void>>;
type FuncTable<T extends Instruction> = Map<number, (instruction: T, cpu: CPU) => void>;

const opcode0x03func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, chip } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const byte = signExtend8(chip.readUint8(rs1Value + imm));
    registerSet.setRegister(rd, byte);
  }],

  [0x1, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, chip } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const half = signExtend16(chip.readUint16(rs1Value + imm));
    registerSet.setRegister(rd, half);
  }],

  [0x2, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, chip } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const word = chip.readUint32(rs1Value + imm); //CHECK Int32?
    registerSet.setRegister(rd, word);
  }],

  [0x4, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, chip } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const byte = chip.readUint8(rs1Value + imm);
    registerSet.setRegister(rd, byte);
  }],

  [0x5, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, chip } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const half = chip.readUint16(rs1Value + imm);
    registerSet.setRegister(rd, half);
  }],
]);

const opcode0x0ffunc3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => { // TODO FENCE
    const { registerSet, chip } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    console.log("FENCE not implemented");
  }],
]);

const opcode0x13func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value + imm;

    registerSet.setRegister(rd, result);
  }],

  [0x1, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, func7, immU, shamt } = instruction;
    const { registerSet } = cpu;

    if (func7 === 0) { // slli
      const rs1Value = registerSet.getRegisterU(rs1);
      const result = rs1Value << shamt;
      registerSet.setRegisterU(rd, result);
    } else if (func7 === 0x14) { // bseti (Zbb)
      const rs1Value = registerSet.getRegister(rs1);
      const result = rs1Value | ( 1 << shamt);
      registerSet.setRegister(rd, result);
    } else if (func7 === 0x24) { // bclri (Zbs)
      const rs1Value = registerSet.getRegister(rs1);
      const result = rs1Value & ~(1 << shamt);
      registerSet.setRegister(rd, result);
    } else if (immU === 0b011000000001) { // ctz (Zbb)
      const rs1Value = registerSet.getRegister(rs1);
      let tmp = rs1Value >>> 0;
      if (tmp === 0) {
        registerSet.setRegister(rd, 32);
      } else {
        tmp &= -tmp;
        tmp = 31 - Math.clz32(tmp);
        registerSet.setRegister(rd, tmp);
      }
    } else if (immU === 0b011000000010) { // cpop (Zbb)
      const rs1Value = registerSet.getRegister(rs1);
      let tmp = rs1Value >>> 0;
      tmp = tmp - ((tmp >> 1) & 0x55555555);
      tmp = (tmp & 0x33333333) + ((tmp >> 2) & 0x33333333);
      tmp = ((tmp + (tmp >> 4) & 0xF0F0F0F) * 0x1010101) >> 24;
      registerSet.setRegister(rd, tmp);
    } else if (immU === 0b011000000101) { // sext.h (Zbb)
      const rs1Value = registerSet.getRegisterU(rs1);
      const value = signExtend16(rs1Value & 0xffff);
      registerSet.setRegister(rd, value);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x2, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    if ( func7 === 0) { // slti
      const result = rs1Value < imm ? 1 : 0;
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x3, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);

    if ( func7 === 0) { // sltiu
      const result = rs1Value < immU ? 1 : 0;
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x4, (instruction: I_Type, cpu: CPU) => { // xori
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value ^ imm;

    registerSet.setRegister(rd, result);
  }],

  [0x5, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm, func7, shamt } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    if (func7 === 0x00) { // srli
      const result = rs1Value >>> shamt;
      registerSet.setRegister(rd, result);

    } else if (func7 === 0x20) { // srai
      const result = rs1Value >> shamt;
      registerSet.setRegister(rd, result);

    } else if (func7 === 0x24) { // bexti (Zbs)
      const result = (rs1Value >>> shamt) & 1;
      registerSet.setRegister(rd, result);

    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x6, (instruction: I_Type, cpu: CPU) => { // ori
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value | imm;
    registerSet.setRegister(rd, result);
  }],

  [0x7, (instruction: I_Type, cpu: CPU) => { // andi
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value & imm;
    registerSet.setRegister(rd, result);
  }],
]);

const opcode0x23func3Table: FuncTable<S_Type> = new Map([
  [0x0, (instruction: S_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet, chip } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const byte = getRange(rs2Value, 7, 0);

    chip.writeUint8(rs1Value + imm, byte); //CHECK Int8?
  }],

  [0x1, (instruction: S_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet, chip } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const half = getRange(rs2Value, 15, 0);

    chip.writeUint16(rs1Value + imm, half); //CHECK Int16?
  }],

  [0x2, (instruction: S_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet, chip } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    chip.writeUint32(rs1Value + imm, rs2Value); //CHECK Int32?
  }],
]);

const opcode0x2ffunc3Table: FuncTable<R_Type> = new Map([
  [0x2, (instruction: R_Type, cpu: CPU) => {

    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet, chip } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (func7 === 0x22) { // amoor.w.aq (rv32a)
      // x[rd] = AMO32(M[x[rs1]] | x[rs2])
      const rs1Mem = chip.readUint32(rs1Value);
      registerSet.setRegister(rd, rs1Mem);
      const value = rs1Mem | rs2Value;
      chip.writeUint32(rs1Value, value);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],
]);

const opcode0x33func3Table: FuncTable<R_Type> = new Map([
  [0x0, (instruction: R_Type, cpu: CPU) => {

    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (func7 === 0x00) {
      const sum = rs1Value + rs2Value;
      registerSet.setRegister(rd, sum);

    } else if (func7 === 0x20) {
      const difference = registerSet.getRegister(rs1) - registerSet.getRegister(rs2);
      registerSet.setRegister(rd, difference);
    } else if (func7 === 0x1) { // mul (rv32m)
      const result = registerSet.getRegister(rs1) * registerSet.getRegister(rs2);
      registerSet.setRegister(rd, result & 0xffffffff); // FIXME check sign
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);

  }],

  [0x1, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    if(func7 === 0) { // sll
      const result = rs1Value << rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x14) { // bset (Zbs)
      const index = rs2Value & 31;
      const result = rs1Value | (1 << index);
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x24) { // bclr (Zbs)
      const index = rs2Value & 31;
      const result = rs1Value & ~(1 << index);
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x2, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if(func7 === 0) { // slt
      if(rd === 0 && rs1 === 0) {
        if(rs2 === 0) { // h3.block (Xh3power) - slt x0, x0, x0
          if(!cpu.eventRegistered) {
            cpu.waiting = true;
            return;
          } else {
            cpu.eventRegistered = false;
            return;
          }
        } else if(rs2 === 1) { // h3.unblock (Xh3power) - slt x0, x0, x1
          if(cpu.onSEV) cpu.onSEV();
          return;
        }
      }
      const result = rs1Value < rs2Value ? 1 : 0;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x10) { // sh1add (Zbb)
      const result = ((rs1Value << 1) + rs2Value) & 0xffffffff;
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x3, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    if(func7 === 0) {
      const result = rs1Value < rs2Value ? 1 : 0;
      registerSet.setRegister(rd, result);
    } else if(func7 === 1) { // mulhu (rv32m)
      const result = (rs1Value * rs2Value) >> 32;
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x4, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if(func7 === 0) {
      const result = rs1Value ^ rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x10) { // sh2add (Zbb)
      const result = ((rs1Value << 2) + rs2Value) & 0xffffffff;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x4) { // PACK (Zbkb)
      const result = (rs1Value & 0xffff) | ((rs2Value & 0xffff) << 16);
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x5, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (func7 === 0x00) {
      const result = rs1Value >>> rs2Value;
      registerSet.setRegister(rd, result);

    } else if (func7 === 0x20) {
      const result = rs1Value >> rs2Value;
      registerSet.setRegister(rd, result);
    } else if (func7 === 0x24) { // bext (Zbs)
      const result = rs1Value >>> (rs2Value & 31);
      registerSet.setRegister(rd, result);
    } else if (func7 === 0x01) { // divu (rv32m)
      const result = (rs1Value / rs2Value) >>> 0;
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);

  }],

  [0x6, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if(func7 === 0) { // OR
      const result = rs1Value | rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x5) { // MAX (Zbb)
      const result = rs1Value > rs2Value ? rs1Value : rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x20) { // ORN (Zbb)
      const result = rs1Value | ~rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x10) { // sh3add (Zbb)
      const result = ((rs1Value << 3) + rs2Value) & 0xffffffff;
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x7, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2, func7 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if(func7 === 0) { // AND
      const result = rs1Value & rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x20) { // ANDN (Zbb)
      const result = rs1Value & ~rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x4) { // PACKH (Zbkb)
      const result = (rs1Value & 0xff) | ((rs2Value & 0xff) << 8);
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x5) { // MAXU (Zbkb)
      const result = (rs1Value >>> 0) > (rs2Value >>> 0) ? rs1Value : rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x1) { // REMU (RV32M)
      const result = (rs2Value === 0) ? rs1Value : (rs1Value % rs2Value);
      registerSet.setRegister(rd, result);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

]);

const opcode0x63func3Table: FuncTable<B_Type> = new Map([
  [0x0, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (rs1Value === rs2Value) {
      cpu.next_pc = cpu.pc + imm;
    }
  }],

  [0x1, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (rs1Value !== rs2Value) {
      cpu.next_pc = cpu.pc + imm;
    }
  }],

  [0x4, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (rs1Value < rs2Value) {
      cpu.next_pc = cpu.pc + imm;
    }
  }],

  [0x5, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (rs1Value >= rs2Value) {
      cpu.next_pc = cpu.pc + imm;
    }
  }],

  [0x6, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    if (rs1Value < rs2Value) {
      cpu.next_pc = cpu.pc + imm;
    }
  }],

  [0x7, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    if (rs1Value >= rs2Value) {
      cpu.next_pc = cpu.pc + imm;
    }
  }],
]);

const opcode0x67func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    registerSet.setRegister(rd, cpu.pc + cpu.inst_length);
    cpu.next_pc = rs1Value + imm;
  }]
]);

const opcode0x73func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { rd, func7 } = instruction;
    throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],
  [0x1, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction; // immU is csr
    const { registerSet } = cpu;
    // TODO: Implement CSRW
    // 30551073                csrw    mtvec,a0
    let value = 0;
    if (immU === 0x305) { // MTVEC
      value = cpu.mtvec;
      cpu.mtvec = registerSet.getRegister(rs1);
      console.log("CSRW MTVEC");
    } else {
      console.log("CSRW not implemented");
    }
    if(rd !== 0) {
      registerSet.setRegister(rd, value);
    }
  }],
  [0x2, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction; // immU is csr
    const { registerSet } = cpu;
    // if(rd != 0) rd.value = csr[addr];
    // if (rs1.value != 0) csr[addr] = csr[addr] | rs1.value;
    if ( rd === 0x0 ) {
      // TODO: Implement CSRS
      // 3006a073                csrs    mstatus,a3 ; (potentially) set interupt enable bit
      console.log(`CSRS not implemented, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
    } else if (rs1 === 0x0) {
      // TODO: Implement CSRR
      // 305027f3                csrr    a5,mtvec
      if(immU == 0x305) {
        registerSet.setRegister(rd, cpu.mtvec);
        console.log(`CSRR read MTVEC, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
      } else if(immU == 0xbe5) {
        // 20000e10:       be502773                csrr    a4,0xbe5
        // 20000e14:       01071793                slli    a5,a4,0x10
        // 20000e18:       0407da63                bgez    a5,20000e6c <best_effort_wfe_or_timeout+0x68>
        registerSet.setRegister(rd, 0x8000); // return "not in interrupt" flag
        console.log(`CSRR read 0xbe5, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
      } else if(immU == 0xf14) {
        // f1402573                csrr    a0,mhartid
        registerSet.setRegister(rd, cpu.mhartid);
      } else {
        console.log(`CSRR not implemented, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
      }
    }
  }],
  [0x3, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction; // rs1 is iumm, immU is csr
    const { registerSet } = cpu;
    // TODO: Implement CSRC
    // be253073                csrc    0xbe2,a0
    console.log(`CSRC not implemented, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
  }],
  [0x5, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction; // rs1 is iumm, immU is csr
    const { registerSet } = cpu;
    // TODO: Implement CSRWI
    // bf035073                csrwi   0xbf0,6
    console.log(`CSRWI not implemented, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
  }],
  [0x6, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction; // rs1 is iumm, immU is csr
    const { registerSet } = cpu;
    // 30046073                csrsi   mstatus,8 (csrrsi x0, mstatus, 8)
    console.log(`CSRRSI not implemented, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
    registerSet.setRegister(rd, 0);
  }],
  [0x7, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction; // rs1 is iumm, immU is csr
    const { registerSet } = cpu;
    // TODO: Implement CSRRCI
    // 30047773                csrrci  a4,mstatus,8 ; clear Interrupt enable bit and set a4=mstatus
    // t = CSRs[csr]; CSRs[csr] = t &∼zimm; x[rd] = t
    console.log(`CSRRCI not implemented, rd 0x${rd.toString(16)}, rs1 0x${rs1.toString(16)}, csr 0x${immU.toString(16)}`);
    registerSet.setRegister(rd, 0);
  }]
]);

const r_TypeOpcodeTable: OpcodeFuncTable<R_Type> = new Map([
  [0x2f, opcode0x2ffunc3Table],
  [0x33, opcode0x33func3Table]
]);

const i_TypeOpcodeTable: OpcodeFuncTable<I_Type> = new Map([
  [0x03, opcode0x03func3Table],
  [0x0f, opcode0x0ffunc3Table],
  [0x13, opcode0x13func3Table],
  [0x67, opcode0x67func3Table],
  [0x73, opcode0x73func3Table]
]);

const s_TypeOpcodeTable: OpcodeFuncTable<S_Type> = new Map([
  [0x23, opcode0x23func3Table]
]);

const b_TypeOpcodeTable: OpcodeFuncTable<B_Type> = new Map([
  [0x63, opcode0x63func3Table]
]);

const u_TypeOpcodeTable: OpcodeTable<U_Type> = new Map([
  [0x37, (instruction: U_Type, cpu: CPU) => { // lui
    const { rd, imm } = instruction;
    const { registerSet } = cpu;

    registerSet.setRegister(rd, imm);
  }],

  [0x17, (instruction: U_Type, cpu: CPU) => { // auipc
    const { rd, imm } = instruction;
    const { registerSet } = cpu;

    registerSet.setRegister(rd, imm + cpu.pc);
  }]
]); 

const j_TypeOpcodeTable: OpcodeTable<J_Type> = new Map([
  [0x6F, (instruction: J_Type, cpu: CPU) => {
    const { rd, imm } = instruction;
    const { registerSet } = cpu;

    registerSet.setRegister(rd, cpu.pc + cpu.inst_length);
    cpu.next_pc = cpu.pc + imm;
  }]
]);

const opcodeTypeTable = new Map<number, InstructionType>([
  [0x03, InstructionType.I], // LOAD
  [0x0f, InstructionType.I], // MISC-MEM
  [0x13, InstructionType.I], // OP-IMM
  [0x17, InstructionType.U], // AUIPC
  [0x23, InstructionType.S], // STORE
  [0x2f, InstructionType.R], // AMO
  [0x33, InstructionType.R], // OP
  [0x37, InstructionType.U], // LUI
  [0x63, InstructionType.B], // BRANCH
  [0x67, InstructionType.I], // JALR
  [0x6F, InstructionType.J], // ?
  [0x73, InstructionType.I], // SYSTEM
])
