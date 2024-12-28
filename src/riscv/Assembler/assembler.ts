import { B_Type, I_Type, Instruction, InstructionType, InstructionValues, J_Type, R_Type, S_Type, U_Type } from "./instruction";

export class Assembler {

  // Convert a a set of assembly instructions to machine code
  static assemble(asm: string[]): ArrayBuffer {

    //const parsedAssembly = parse(asm);

    // TODO: link symbols, labels, sections, files etc.

    const parsedAssembly = asm;

    const binaryBuffer = new ArrayBuffer(parsedAssembly.length * 4);

    const binView = new DataView(binaryBuffer);

    parsedAssembly.forEach((line: string, index: number) => {
      const machineCode = this.assembleLine(line);
      binView.setInt32(index * 4, machineCode.binary, true);
    })

    return binaryBuffer;
  }

  // Convert a single assembly instruction to machine code
  static assembleLine(asm: string): Instruction {

    const tokens = asm.toLowerCase()
      .replace(/,/g, '')
      .replace(/\(|\)/g, ' ')
      .split(' ');
    const baseValues = instructionTable.get(tokens[0]);

    if (baseValues === undefined) {
      throw new Error(`Instruction not found in instruction table; instruction provided: ${tokens[0]}`)
    }

    let instruction: Instruction;

    switch (baseValues.type!!) {
      case InstructionType.R:
        instruction = new R_Type({
          ...baseValues, 
          rd: parseRegister(tokens[1]), 
          rs1: parseRegister(tokens[2]),
          rs2: parseRegister(tokens[3])
        });
        break;

      case InstructionType.I:

        switch (i_Subtypes.get(tokens[0])!! as ImmediateSubtypes) {
          case ImmediateSubtypes.Normal:
            instruction = new I_Type({
              ...baseValues, 
              rd: parseRegister(tokens[1]),
              rs1: parseRegister(tokens[2]),
              imm: parseInt(tokens[3])
            });
            break;

          case ImmediateSubtypes.Indexed:
            instruction = new I_Type({
              ...baseValues, 
              rd: parseRegister(tokens[1]),
              imm: parseInt(tokens[2]),
              rs1: parseRegister(tokens[3])
            });
            break;

          case ImmediateSubtypes.Shamt:
            instruction = new I_Type({
              ...baseValues, 
              rd: parseRegister(tokens[1]),
              rs1: parseRegister(tokens[2]),
              shamt: parseInt(tokens[3])
            });
            break;

          case ImmediateSubtypes.Ecall:
            instruction = new I_Type({
              ...baseValues
            });
            break;

        }
        break;

      case InstructionType.S:
        instruction = new S_Type({
          ...baseValues, 
          rs2: parseRegister(tokens[1]),
          imm: parseInt(tokens[2]),
          rs1: parseRegister(tokens[3])
        });
        break;

      case InstructionType.B:
        instruction = new B_Type({
          ...baseValues, 
          rs1: parseRegister(tokens[1]), 
          rs2: parseRegister(tokens[2]),
          imm: parseInt(tokens[3]),
        });
        break;

      case InstructionType.U:
        instruction = new U_Type({
          ...baseValues, 
          rd: parseRegister(tokens[1]), 
          imm: parseInt(tokens[2]),
        });
        break;

      case InstructionType.J:
        instruction = new J_Type({
          ...baseValues, 
          rd: parseRegister(tokens[1]), 
          imm: parseInt(tokens[2]),
        });
        break;

    }

    return instruction;

  }

}

/*
=====================================================
===============   Register Aliases:   ===============
=====================================================

x0          zero           Hard-wired zero
x1          ra             Return address
x2          sp             Stack Pointer
x3          gp             Global Pointer
x4          tp             Thread Pointer
x5          t0             Temporary register/Alternative link
x6-7        t1-2           Temporary registers
x8          s0/fp          Saved Register/Frame pointer
x9          s1             Saved Register
x10-11      a0-1           Function Arguments/Return value
x12-17      a2-7           Function Arguments
x18-27      s2-11          Saved Registers
x28-31      t3-6           Temporaries

Source: Page 137 of Volume I: RISC-V Unprivileged ISA V20191213

*/

function parseRegister(registerName: string): number {
  const registerIndex = registerTable.get(registerName);
  if (registerIndex === undefined) {
    throw new Error(`Register name not found in register table; Name provided: ${registerName}`);
  }

  return registerIndex;
}

const registerTable = new Map<string, number>([
  ['x0', 0],
  ['x1', 1],
  ['x2', 2],
  ['x3', 3],
  ['x4', 4],
  ['x5', 5],
  ['x6', 6],
  ['x7', 7],
  ['x8', 8],
  ['x9', 9],
  ['x10', 10],
  ['x11', 11],
  ['x12', 12],
  ['x13', 13],
  ['x14', 14],
  ['x15', 15],
  ['x16', 16],
  ['x17', 17],
  ['x18', 18],
  ['x19', 19],
  ['x20', 20],
  ['x21', 21],
  ['x22', 22],
  ['x23', 23],
  ['x24', 24],
  ['x25', 25],
  ['x26', 26],
  ['x27', 27],
  ['x28', 28],
  ['x29', 29],
  ['x30', 30],
  ['x31', 31],

  ['zero', 0],
  ['ra', 1],
  ['sp', 2],
  ['gp', 3],
  ['tp', 4],
  ['t0', 5],
  ['t1', 6],
  ['t2', 7],
  ['s0', 8],
  ['fp', 8],
  ['s1', 9],
  ['a0', 10],
  ['a1', 11],
  ['a2', 12],
  ['a3', 13],
  ['a4', 14],
  ['a5', 15],
  ['a6', 16],
  ['a7', 17],
  ['s2', 18],
  ['s3', 19],
  ['s4', 20],
  ['s5', 21],
  ['s6', 22],
  ['s7', 23],
  ['s8', 24],
  ['s9', 25],
  ['s10', 26],
  ['s11', 27],
  ['t3', 28],
  ['t4', 29],
  ['t5', 30],
  ['t6', 31],

])

const instructionTable = new Map<string, InstructionValues>([
  ['lui',   { type: InstructionType.U, opcode: 0x37 }],
  ['auipc', { type: InstructionType.U, opcode: 0x17 }],

  ['jal',   { type: InstructionType.J, opcode: 0x6F }],
  ['jalr',  { type: InstructionType.I, opcode: 0x67, func3: 0x0 }],

  ['beq',   { type: InstructionType.B, opcode: 0x63, func3: 0x0 }],
  ['bne',   { type: InstructionType.B, opcode: 0x63, func3: 0x1 }],
  ['blt',   { type: InstructionType.B, opcode: 0x63, func3: 0x4 }],
  ['bge',   { type: InstructionType.B, opcode: 0x63, func3: 0x5 }],
  ['bltu',  { type: InstructionType.B, opcode: 0x63, func3: 0x6 }],
  ['bgeu',  { type: InstructionType.B, opcode: 0x63, func3: 0x7 }],

  ['lb',    { type: InstructionType.I, opcode: 0x03, func3: 0x0 }],
  ['lh',    { type: InstructionType.I, opcode: 0x03, func3: 0x1 }],
  ['lw',    { type: InstructionType.I, opcode: 0x03, func3: 0x2 }],
  ['lbu',   { type: InstructionType.I, opcode: 0x03, func3: 0x4 }],
  ['lhu',   { type: InstructionType.I, opcode: 0x03, func3: 0x5 }],

  ['sb',    { type: InstructionType.S, opcode: 0x23, func3: 0x0 }],
  ['sh',    { type: InstructionType.S, opcode: 0x23, func3: 0x1 }],
  ['sw',    { type: InstructionType.S, opcode: 0x23, func3: 0x2 }],

  ['addi',  { type: InstructionType.I, opcode: 0x13, func3: 0x0 }],
  ['slti',  { type: InstructionType.I, opcode: 0x13, func3: 0x2 }],
  ['sltiu', { type: InstructionType.I, opcode: 0x13, func3: 0x3 }],
  ['xori',  { type: InstructionType.I, opcode: 0x13, func3: 0x4 }],
  ['ori',   { type: InstructionType.I, opcode: 0x13, func3: 0x6 }],
  ['andi',  { type: InstructionType.I, opcode: 0x13, func3: 0x7 }],
  ['slli',  { type: InstructionType.I, opcode: 0x13, func3: 0x1, func7: 0x00 }],
  ['srli',  { type: InstructionType.I, opcode: 0x13, func3: 0x5, func7: 0x00 }],
  ['srai',  { type: InstructionType.I, opcode: 0x13, func3: 0x5, func7: 0x20 }],

  ['add',   { type: InstructionType.R, opcode: 0x33, func3: 0x0, func7: 0x00 }],
  ['sub',   { type: InstructionType.R, opcode: 0x33, func3: 0x0, func7: 0x20 }],
  ['sll',   { type: InstructionType.R, opcode: 0x33, func3: 0x1, func7: 0x00 }],
  ['slt',   { type: InstructionType.R, opcode: 0x33, func3: 0x2, func7: 0x00 }],
  ['sltu',  { type: InstructionType.R, opcode: 0x33, func3: 0x3, func7: 0x00 }],
  ['xor',   { type: InstructionType.R, opcode: 0x33, func3: 0x4, func7: 0x00 }],
  ['srl',   { type: InstructionType.R, opcode: 0x33, func3: 0x5, func7: 0x00 }],
  ['sra',   { type: InstructionType.R, opcode: 0x33, func3: 0x5, func7: 0x20 }],
  ['or',    { type: InstructionType.R, opcode: 0x33, func3: 0x6, func7: 0x00 }],
  ['and',   { type: InstructionType.R, opcode: 0x33, func3: 0x7, func7: 0x00 }],

  ['ecall', { type: InstructionType.I,  opcode: 0x73, func3: 0x0, func7: 0x00 }],
])

enum ImmediateSubtypes {
  Normal,
  Shamt,
  Indexed,
  Ecall
}

const i_Subtypes = new Map<string, ImmediateSubtypes>([

  ['jalr',  ImmediateSubtypes.Indexed],

  ['lb',    ImmediateSubtypes.Indexed],
  ['lh',    ImmediateSubtypes.Indexed],
  ['lw',    ImmediateSubtypes.Indexed],
  ['lbu',   ImmediateSubtypes.Indexed],
  ['lhu',   ImmediateSubtypes.Indexed],

  ['addi',  ImmediateSubtypes.Normal],
  ['slti',  ImmediateSubtypes.Normal],
  ['sltiu', ImmediateSubtypes.Normal],
  ['xori',  ImmediateSubtypes.Normal],
  ['ori',   ImmediateSubtypes.Normal],
  ['andi',  ImmediateSubtypes.Normal],

  ['slli',  ImmediateSubtypes.Shamt],
  ['srli',  ImmediateSubtypes.Shamt],
  ['srai',  ImmediateSubtypes.Shamt],

  ['ecall', ImmediateSubtypes.Ecall],
])