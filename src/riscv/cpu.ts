import { B_Type, I_Type, Instruction, InstructionType, J_Type, R_Type, S_Type, U_Type } from "./Assembler/instruction";
import { getRange } from "./binaryFunctions";
import { RP2040 } from "../rp2040";
import { decompress_rv32c_inst } from "./rv32c";

export class CPU {

  registerSet: RegisterSet = new RegisterSet(32);
  pc = 0;
  next_pc = 0;
  waiting = false; //TODO
  stopped = false; //TODO
  cycles = 0; //TODO
  eventRegistered = false; //TODO

  constructor(readonly chip: RP2040, readonly coreLabel: string) {
  }

  reset() { } //TODO

  setInterrupt(a: any, b: any) { } //TODO

  private inst_buffer = 0;
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
    console.log(`PC 0x${this.pc.toString(16)} - fetching`);
    const instruction = this.fetchInstruction();
    console.log(`executing (decoded) instr 0x${instruction.toString(16)}`);
    this.step(instruction);
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
        throw Error(`Invalid instruction: 0x${instruction.toString(16)} at 0x${this.pc.toString(16)}`);
        break;
    }

    if(this.next_pc != this.pc) {
      this.inst_buffer = 0;
      this.pc = this.next_pc;
    } else {
      this.pc += this.inst_length;
      this.next_pc = this.pc;
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

    const byte = chip.readUint8(rs1Value + imm); //CHECK Int8?
    registerSet.setRegister(rd, byte);
  }],

  [0x1, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, chip } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const half = chip.readUint16(rs1Value + imm); //CHECK Int16?
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

const opcode0x13func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value + imm;

    registerSet.setRegister(rd, result);
  }],

  [0x1, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, shamt } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value << shamt;

    registerSet.setRegister(rd, result);
  }],

  [0x2, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value < imm ? 1 : 0;

    registerSet.setRegister(rd, result);
  }],

  [0x3, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);

    const result = rs1Value < immU ? 1 : 0;

    registerSet.setRegister(rd, result);
  }],

  [0x4, (instruction: I_Type, cpu: CPU) => {
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

    if (func7 === 0x00) {
      const result = rs1Value >>> shamt;
      registerSet.setRegister(rd, result);

    } else if (func7 === 0x20) {
      const result = rs1Value >> shamt;
      registerSet.setRegister(rd, result);
    }
  }],

  [0x6, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value | imm;

    registerSet.setRegister(rd, result);
  }],

  [0x7, (instruction: I_Type, cpu: CPU) => {
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
    }

  }],

  [0x1, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    const result = rs1Value << rs2Value;
    registerSet.setRegister(rd, result);
  }],

  [0x2, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const result = rs1Value < rs2Value ? 1 : 0;
    registerSet.setRegister(rd, result);
  }],

  [0x3, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    const result = rs1Value < rs2Value ? 1 : 0;
    registerSet.setRegister(rd, result);
  }],

  [0x4, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const result = rs1Value ^ rs2Value;
    registerSet.setRegister(rd, result);
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
    }

  }],

  [0x6, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const result = rs1Value | rs2Value;
    registerSet.setRegister(rd, result);
  }],

  [0x7, (instruction: R_Type, cpu: CPU) => {
    const { rd, rs1, rs2 } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const result = rs1Value & rs2Value;
    registerSet.setRegister(rd, result);
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
    // TODO: Implement ECALL
  }],
  [0x2, (instruction: I_Type, cpu: CPU) => {
    // TODO: Implement crrw properly
    const { rd } = instruction;
    const { registerSet } = cpu;
    registerSet.setRegister(rd, 0);
  }]
]);

const r_TypeOpcodeTable: OpcodeFuncTable<R_Type> = new Map([
  [0x33, opcode0x33func3Table]
]);

const i_TypeOpcodeTable: OpcodeFuncTable<I_Type> = new Map([
  [0x03, opcode0x03func3Table],
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
  [0x37, (instruction: U_Type, cpu: CPU) => {
    const { rd, imm } = instruction;
    const { registerSet } = cpu;

    registerSet.setRegister(rd, imm);
  }],

  [0x17, (instruction: U_Type, cpu: CPU) => {
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
  [0x03, InstructionType.I],
  [0x13, InstructionType.I],
  [0x17, InstructionType.U],
  [0x23, InstructionType.S],
  [0x33, InstructionType.R],
  [0x37, InstructionType.U],
  [0x63, InstructionType.B],
  [0x67, InstructionType.I],
  [0x6F, InstructionType.J],
  [0x73, InstructionType.I],
])