import { getBit, getRange, setRange, signExtend } from "../binaryFunctions";

export abstract class Instruction {

  binary: number;

  abstract type: InstructionType;

  constructor(options: InstructionValues) {

    if (options.binary) {
      this.binary = options.binary;

    } else if (options.opcode) {
      this.binary = 0;

      if (options.opcode) {
        this.binary = setRange(this.binary, options.opcode, 6, 0);
      }
      
      if (options.rd) {
        this.binary = setRange(this.binary, options.rd, 11, 7);
      }

      if (options.rs1) {
        this.binary = setRange(this.binary, options.rs1, 19, 15);
      }

      if (options.rs2) {
        this.binary = setRange(this.binary, options.rs2, 24, 20);
      }

      if (options.func3) {
        this.binary = setRange(this.binary, options.func3, 14, 12);
      }

      if (options.func7) {
        this.binary = setRange(this.binary, options.func7, 31, 25);
      }

      if (options.shamt) {
        this.binary = setRange(this.binary, options.shamt, 24, 20);
      }

    } else {
      throw new Error('Instruction must be constructed with at least a binary value OR opcode value');
    }

  }

  get opcode() {
    return getRange(this.binary, 6, 0);
  }

  set opcode(value: number) {
    this.binary = setRange(this.binary, value, 6, 0);
  }

}

export class R_Type extends Instruction {

  type: InstructionType;

  constructor(options: InstructionValues) {
    super(options);
    this.type = InstructionType.R;
  }

  get rd() {
    return getRange(this.binary, 11, 7);
  }

  set rd(value: number) {
    this.binary = setRange(this.binary, value, 11, 7);
  }

  get func3() {
    return getRange(this.binary, 14, 12);
  }

  set func3(value: number) {
    this.binary = setRange(this.binary, value, 14, 12);
  }

  get rs1() {
    return getRange(this.binary, 19, 15);
  }

  set rs1(value: number) {
    this.binary = setRange(this.binary, value, 19, 15);
  }

  get rs2() {
    return getRange(this.binary, 24, 20);
  }

  set rs2(value: number) {
    this.binary = setRange(this.binary, value, 24, 20);
  }

  get func7() {
    return getRange(this.binary, 31, 25);
  }

  set func7(value: number) {
    this.binary = setRange(this.binary, value, 31, 25);
  }

}

export class I_Type extends Instruction implements HasImmediate {

  type: InstructionType;

  constructor(options: InstructionValues) {
    super(options);
    this.type = InstructionType.I;

    if (options.imm) {
      this.imm = options.imm;
    }

  }

  get rd() {
    return getRange(this.binary, 11, 7);
  }

  set rd(value: number) {
    this.binary = setRange(this.binary, value, 11, 7);
  }

  get func3() {
    return getRange(this.binary, 14, 12);
  }

  set func3(value: number) {
    this.binary = setRange(this.binary, value, 14, 12);
  }

  get rs1() {
    return getRange(this.binary, 19, 15);
  }

  set rs1(value: number) {
    this.binary = setRange(this.binary, value, 19, 15);
  }

  get func7() {
    return getRange(this.binary, 31, 25);
  }

  set func7(value: number) {
    this.binary = setRange(this.binary, value, 31, 25);
  }

  get shamt() {
    return getRange(this.binary, 24, 20);
  }

  set shamt(value: number) {
    this.binary = setRange(this.binary, value, 24, 20);
  }

  get imm() {
    return signExtend(this.immU, 12);
  }

  get immU() {
    return getRange(this.binary, 31, 20);
  }

  set imm(value: number) {
    this.binary = setRange(this.binary, value, 31, 20);
  }

}

export class S_Type extends Instruction implements HasImmediate {

  type: InstructionType;

  constructor(options: InstructionValues) {
    super(options);
    this.type = InstructionType.S;

    if (options.imm) {
      this.imm = options.imm;
    }
  }

  get func3() {
    return getRange(this.binary, 14, 12);
  }

  set func3(value: number) {
    this.binary = setRange(this.binary, value, 14, 12);
  }

  get rs1() {
    return getRange(this.binary, 19, 15);
  }

  set rs1(value: number) {
    this.binary = setRange(this.binary, value, 19, 15);
  }

  get rs2() {
    return getRange(this.binary, 24, 20);
  }

  set rs2(value: number) {
    this.binary = setRange(this.binary, value, 24, 20);
  }

  get imm() {
    return signExtend(this.immU, 12);
  }

  get immU() {
    return getRange(this.binary, 11, 7) + (getRange(this.binary, 31, 25) << 13);
  }

  set imm(value: number) {
    const imm5 = getRange(value, 4, 0);
    const imm7 = getRange(value, 11, 5);

    this.binary = setRange(this.binary, imm5, 11, 7);
    this.binary = setRange(this.binary, imm7, 31, 25);
  }

}

export class B_Type extends Instruction implements HasImmediate {

  type: InstructionType;

  constructor(options: InstructionValues) {
    super(options);
    this.type = InstructionType.B;

    if (options.imm) {
      this.imm = options.imm;
    }
  }

  get func3() {
    return getRange(this.binary, 14, 12);
  }

  set func3(value: number) {
    this.binary = setRange(this.binary, value, 14, 12);
  }

  get rs1() {
    return getRange(this.binary, 19, 15);
  }

  set rs1(value: number) {
    this.binary = setRange(this.binary, value, 19, 15);
  }

  get rs2() {
    return getRange(this.binary, 24, 20);
  }

  set rs2(value: number) {
    this.binary = setRange(this.binary, value, 24, 20);
  }

  get imm() {
    return signExtend(this.immU, 13);
  }

  get immU() {

    const imm5 = getRange(this.binary, 11, 7);
    const imm7 = getRange(this.binary, 31, 25);

    return (
      (getRange(imm5, 4, 1) << 1) +
      (getBit(imm5, 0) << 11) +
      (getRange(imm7, 5, 0) << 5) +
      (getBit(imm7, 6) << 12)
    )
  }

  set imm(value: number) {

    const imm4_1 = getRange(value, 4, 1);
    const imm10_5 = getRange(value, 10, 5);
    const imm11 = getBit(value, 11);
    const imm12 = getBit(value, 12);

    const imm5 = (imm4_1 << 1) + imm11;
    const imm7 = (imm12 << 6) + imm10_5;

    this.binary = setRange(this.binary, imm5, 11, 7);
    this.binary = setRange(this.binary, imm7, 31, 25);
  }

}

export class U_Type extends Instruction implements HasImmediate {

  type: InstructionType;

  constructor(options: InstructionValues) {
    super(options);
    this.type = InstructionType.U;

    if (options.imm) {
      this.imm = options.imm;
    }
  }

  get rd() {
    return getRange(this.binary, 11, 7);
  }

  set rd(value: number) {
    this.binary = setRange(this.binary, value, 11, 7);
  }

  get imm() {
    return signExtend(this.immU, 20);
  }

  get immU() {
    return getRange(this.binary, 31, 12) << 12;
  }

  set imm(value: number) {
    this.binary = setRange(this.binary, value >> 12, 31, 12);
  }

}

export class J_Type extends Instruction implements HasImmediate {

  type: InstructionType;

  constructor(options: InstructionValues) {
    super(options);
    this.type = InstructionType.J;

    if (options.imm) {
      this.imm = options.imm;
    }
  }

  get rd() {
    return getRange(this.binary, 11, 7);;
  }

  set rd(value: number) {
    this.binary = setRange(this.binary, value, 11, 7);
  }

  get imm() {
    return signExtend(this.immU, 21);
  }

  get immU() {

    const imm = getRange(this.binary, 31, 12);

    return (
      (getRange(imm, 18, 9) << 1) +
      (getBit(imm, 8) << 11) +
      (getRange(imm, 7, 0) << 12) +
      (getBit(imm, 19) << 20)
    );
  }

  set imm(value: number) {
    const imm10_1 = getRange(value, 10, 1);
    const imm19_12 = getRange(value, 19, 12);
    const imm11 = getBit(value, 11);
    const imm20 = getBit(value, 20);

    const imm = (
      imm19_12 +
      (imm11 << 8) +
      (imm10_1 << 9) +
      (imm20 << 19)
    )

    this.binary = setRange(this.binary, imm, 31, 12);

  }

}

export enum InstructionType {
  R,
  I,
  S,
  B,
  U,
  J
}

export interface InstructionValues {
  binary?: number,
  opcode?: number,
  rd?: number,
  rs1?: number,
  rs2?: number,
  func3?: number,
  func7?: number,
  shamt?: number,
  imm?: number

  type?: InstructionType
}

interface HasImmediate {
  imm: number,
  immU: number
}