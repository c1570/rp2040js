import { B_Type, I_Type, Instruction, InstructionType, J_Type, R_Type, S_Type, U_Type } from "./Assembler/instruction";
import { getRange } from "./binaryFunctions";

export class CPU {

  registerSet: RegisterSet = new RegisterSet(32);
  ram: DataView;

  constructor(ram: ArrayBuffer, public pc: number) {
    this.ram = new DataView(ram);
  }

  executionStep() {
    const instruction = this.ram.getInt32(this.pc, true);
    this.executeInstruction(instruction);
  }
  
  executeInstruction(instruction: number) {

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
      console.log('WARNING: Invalid Instruction');
    }

    this.pc += 4;

  }

  private executeI_Type(instruction: I_Type) {
    const { opcode, func3 } = instruction;

    // Get func3 lookup table for I_Type instructions
    const funcTable = i_TypeOpcodeTable.get(opcode);

    const operation = funcTable?.get(func3);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      console.log('WARNING: Invalid Instruction');
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
      console.log('WARNING: Invalid Instruction');
    }

    this.pc += 4;

  }

  private executeB_Type(instruction: B_Type) {

    const { opcode, func3 } = instruction;

    // Get func3 lookup table for B_Type instructions
    const funcTable = b_TypeOpcodeTable.get(opcode);

    const operation = funcTable?.get(func3);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      console.log('WARNING: Invalid Instruction');
    }

  }

  private executeU_Type(instruction: U_Type) {
    const { opcode } = instruction;

    // Get func3 lookup table for U_Type instructions
    const operation = u_TypeOpcodeTable.get(opcode);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      console.log('WARNING: Invalid Instruction');
    }

    this.pc += 4;
  }

  private executeJ_Type(instruction: J_Type) {
    const { opcode } = instruction;

    // Get func3 lookup table for J_Type instructions
    const operation = j_TypeOpcodeTable.get(opcode);

    if (operation !== undefined) {
      operation(instruction, this);
    } else {
      console.log('WARNING: Invalid Instruction');
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
    const { registerSet, ram } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const byte = ram.getInt8(rs1Value + imm);
    registerSet.setRegister(rd, byte);

    cpu.pc += 4;
  }],

  [0x1, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, ram } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const half = ram.getInt16(rs1Value + imm);
    registerSet.setRegister(rd, half);

    cpu.pc += 4;
  }],

  [0x2, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, ram } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const word = ram.getInt32(rs1Value + imm);
    registerSet.setRegister(rd, word);

    cpu.pc += 4;
  }],

  [0x4, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, ram } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const byte = ram.getUint8(rs1Value + imm);
    registerSet.setRegister(rd, byte);

    cpu.pc += 4;
  }],

  [0x5, (instruction: I_Type, cpu: CPU) => {
    const { registerSet, ram } = cpu;
    const { rd, rs1, imm } = instruction;
    const rs1Value = registerSet.getRegister(rs1);

    const half = ram.getUint16(rs1Value + imm);
    registerSet.setRegister(rd, half);

    cpu.pc += 4;
  }],
]);

const opcode0x13func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value + imm;

    registerSet.setRegister(rd, result);

    cpu.pc += 4;
  }],

  [0x1, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, shamt } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value << shamt;

    registerSet.setRegister(rd, result);

    cpu.pc += 4;
  }],

  [0x2, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value < imm ? 1 : 0;

    registerSet.setRegister(rd, result);

    cpu.pc += 4;
  }],

  [0x3, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, immU } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);

    const result = rs1Value < immU ? 1 : 0;

    registerSet.setRegister(rd, result);

    cpu.pc += 4;
  }],

  [0x4, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value ^ imm;

    registerSet.setRegister(rd, result);

    cpu.pc += 4;
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

    cpu.pc += 4;
  }],

  [0x6, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value | imm;

    registerSet.setRegister(rd, result);

    cpu.pc += 4;
  }],

  [0x7, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value & imm;

    registerSet.setRegister(rd, result);

    cpu.pc += 4;
  }],
]);

const opcode0x23func3Table: FuncTable<S_Type> = new Map([
  [0x0, (instruction: S_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet, ram } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const byte = getRange(rs2Value, 7, 0);

    ram.setInt8(rs1Value + imm, byte);
  }],

  [0x1, (instruction: S_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet, ram } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const half = getRange(rs2Value, 15, 0);

    ram.setInt16(rs1Value + imm, half);
  }],

  [0x2, (instruction: S_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet, ram } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    ram.setInt32(rs1Value + imm, rs2Value);
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
      cpu.pc += imm;
    } else {
      cpu.pc += 4;
    }
  }],

  [0x1, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (rs1Value !== rs2Value) {
      cpu.pc += imm;
    } else {
      cpu.pc += 4;
    }
  }],

  [0x4, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (rs1Value < rs2Value) {
      cpu.pc += imm;
    } else {
      cpu.pc += 4;
    }
  }],

  [0x5, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    if (rs1Value >= rs2Value) {
      cpu.pc += imm;
    } else {
      cpu.pc += 4;
    }
  }],

  [0x6, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    if (rs1Value < rs2Value) {
      cpu.pc += imm;
    } else {
      cpu.pc += 4;
    }
  }],

  [0x7, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    if (rs1Value >= rs2Value) {
      cpu.pc += imm;
    } else {
      cpu.pc += 4;
    }
  }],
]);

const opcode0x67func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    registerSet.setRegister(rd, cpu.pc + 4);
    cpu.pc = rs1Value + imm;
  }]
]);

const opcode0x73func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    // TODO: Implement ECALL
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

    registerSet.setRegister(rd, cpu.pc + 4);
    cpu.pc += imm;
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