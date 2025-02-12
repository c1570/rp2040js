import { B_Type, I_Type, Instruction, InstructionType, J_Type, R_Type, S_Type, U_Type } from "./Assembler/instruction";
import { getRange } from "./binaryFunctions";
import { IRPChip } from "../rpchip";
import { decompress_rv32c_inst } from "./rv32c";

enum ExecutionMode {
  Mode_Machine,
  Mode_User,
}

class EICAND {
  constructor(readonly irq_number: number, readonly priority: number) {}
}

export class CPU {

  public onSEV?: () => void;
  public waiting = false;
  public eventRegistered = false;

  registerSet: RegisterSet = new RegisterSet(32);
  csrs = new Array<number>(0x1000);
  pc = 0;
  next_pc = 0;
  stopped = false; //TODO
  cycles = 0;
  currentMode: ExecutionMode = ExecutionMode.Mode_Machine;

  interruptsUpdated = false;
  meiea = new Array<number>(512);
  meipa = new Array<number>(512);
  meifa = new Array<number>(512);
  meipra = new Array<number>(512);
  meicand = new Array<EICAND>();

  did_just_jump = false;

  constructor(readonly chip: IRPChip, readonly coreLabel: string, readonly mhartid: number) {
    this.reset();
  }

  get logger() {
    return this.chip.logger;
  }

  reset() { // TODO
    this.meiea.fill(0);
    this.meipa.fill(0);
    this.meifa.fill(0);
    this.meipra.fill(0);
    this.meicand = new Array<EICAND>();
    this.interruptsUpdated = false;

    this.csrs.fill(0);
    this.csrs[0x300] = 3<<11;
    this.csrs[0x301] = 0b01000000100100000001000100000101;
    this.csrs[0x305] = 0x00001fff00;
    this.csrs[0x320] = 0x101;
    //TODO 0x3a1 - 0x7b0
    this.csrs[0xbe5] = 1<<15;
    this.csrs[0xf11] = (0x9<<7)|(0x13);
    this.csrs[0xf12] = 0x1b;
    this.csrs[0xf13] = 0x86fc4e3f;
  }

  inst_length = 0;

  private fetchInstruction(): number {
    let inst = this.chip.readUint16(this.pc);
    if ((inst & 3) != 3) {
        if (inst == 0) {
            throw Error(`Illegal 16 bit instruction 0 at 0x${this.pc.toString(16)}`);
        }

        inst = decompress_rv32c_inst(inst);
        this.inst_length = 2;
    } else {
        // we have a 32 bit instruction
        inst |= this.chip.readUint16(this.pc + 2) << 16;
        if(this.did_just_jump && (this.pc & 3)) this.cycles++; // jumped to non 32 bit aligned instr
        this.inst_length = 4;
    }
    return inst >>> 0;
  }

  printDisassembly() {
    let pc = this.pc;
    if(this.chip.disassembly) {
      const search = (this.pc.toString(16) + ":").replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const re = new RegExp(search + "(.*)");
      const res = re.exec(this.chip.disassembly);
      const dis = (res == null) ? "?" : res[1];
      this.logger.info(this.coreLabel, `PC 0x${this.pc.toString(16)} - ${dis}`);
    } else {
      this.logger.info(this.coreLabel, `PC 0x${this.pc.toString(16)}`);
    }
  }

  executeInstruction() {
    this.checkForInterrupts();
    if (this.waiting) {
      this.cycles++;
      return;
    }
    const instruction = this.fetchInstruction();
    try {
      this.step(instruction);
    } catch(e) {
      this.printDisassembly();
      throw e;
    }
    this.cycles++;
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
      this.did_just_jump = true;
    } else {
      this.pc += this.inst_length;
      this.did_just_jump = false;
    }

  }

  setInterruptEnabled(irq: number, value: boolean) {
    if (value && !this.meiea[irq] && this.meipa[irq]) {
      // interrupt was pending and just has been enabled, put into meicand
      this.meiea[irq] = 1;
      this.meipa[irq] = 0;
      this.setInterrupt(irq, true);
    } else if (!value && this.meiea[irq] && this.meipa[irq]) {
      // interrupt is pending and just has been disabled, remove from meicand
      this.setInterrupt(irq, false);
      this.meipa[irq] = 1;
    }
    this.meiea[irq] = +value;
  }

  setInterrupt(irq: number, value: boolean) {
    //this.logger.warn(this.coreLabel, `New interrupt: ${irq} = ${value}`);
    if (value && !this.meipa[irq] && this.meiea[irq]) {
      this.meipa[irq] = 1;
      this.meicand.push(new EICAND(irq, this.meipra[irq]));
      this.meicand.sort((a,b) => ((b.priority - a.priority) << 9) + (a.irq_number - b.irq_number));
      this.updateMEINEXT();
      this.interruptsUpdated = true;
    } else if (!value && this.meipa[irq]) {
      this.meipa[irq] = 0;
      this.meicand = this.meicand.filter((icand) => icand.irq_number != irq);
      this.updateMEINEXT();
    }
  }

  updateMEINEXT() {
    // updates MEINEXT and MIE.MEIP
    const meicontext_ppreempt = (this.csrs[0xbe5] >>> 24) & 0b1111;
    if(this.meicand.length > 0 && this.meicand[0].priority >= meicontext_ppreempt) {
      // note that we're looking at *PP*REEMPT here - interrupts with equal or higher priority than that ARE visible in MEINEXT
      // but might still NOT trigger a trap in case their priority is lower than *P*REEMPT.
      this.csrs[0xbe4] = this.meicand[0].irq_number << 2;
      this.csrs[0x344] |= 1 << 11;
    } else {
      this.csrs[0xbe4] = (1 << 31) >>> 0;
      this.csrs[0x344] &= ~(1 << 11);
    }
  }

  updateMEICONTEXT_update() {
    // called on MEINEXT.UPDATE write
    // clear NOIRQ and IRQ
    let meicontext = this.csrs[0xbe5];
    meicontext &= ~(0b1001111111110000);
    // update NOIRQ
    meicontext |= (this.csrs[0xbe4] >>> 31) << 15;
    // update IRQ
    const current_irq = (this.csrs[0xbe4] >>> 2) & 511;
    meicontext |= current_irq << 4;
    this.csrs[0xbe5] = meicontext;
  }

  updateMEICONTEXT_priority_save() {
    // called on priority save (external interrupt trap)
    let meicontext = this.csrs[0xbe5];
    // clear PPPREEMPT, PPREEMPT, PREEMPT, MTIESAVE, MSIESAVE, CLEARTS
    meicontext &= 0b1111111111110001;
    // update PPREEMPT from old PREEMPT
    meicontext |= ((this.csrs[0xbe5] >>> 16) & 0b1111) << 24;
    // update PPPREEMPT from old PPREEMPT
    meicontext |= ((this.csrs[0xbe5] >>> 24) & 0b1111) << 28;
    // update PREEMPT
    const current_irq = (this.csrs[0xbe4] >>> 2) & 511;
    if(current_irq > 0) {
      meicontext |= (this.meipra[current_irq] + 1) << 16;
    } else {
      meicontext |= 16 << 16;
    }
    meicontext |= 1; // set MEICONTEXT.MRETEIRQ
    this.csrs[0xbe5] = meicontext;
  }

  updateMEICONTEXT_priority_restore() {
    // called on potential priority restore (mret)
    let meicontext = this.csrs[0xbe5];
    if(!(meicontext & 1)) return; // only proceed if MRETEIRQ is set
    // clear PPP/PP/PREEMPT/MRETEIRQ
    meicontext &= 0b111111111111110;
    // set PPREEMPT from old PPPREEMPT
    meicontext |= (this.csrs[0xbe5] >>> 28) << 24;
    // set PREEMPT from old PPREEMPT
    meicontext |= ((this.csrs[0xbe5] >>> 24) & 0b1111) << 16;
    this.csrs[0xbe5] = meicontext;
  }

  checkForInterrupts() {
    if(!this.interruptsUpdated) return;
    this.interruptsUpdated = false;
    if(this.csrs[0x304] & 0b100000000000) { // if MIE.MEIE is set... TODO consider software and timer interrupts as well
      const meinext_irq_number = (this.csrs[0xbe4] >>> 2) & 511;
      const meinext_irq_prio = this.meipra[meinext_irq_number];
      const meicontext_preempt = (this.csrs[0xbe5] >>> 16) & 0b11111;
      if(meinext_irq_number > 0 && meinext_irq_prio >= meicontext_preempt) { // ...and the interrupt visible in MEINEXT has at least PREEMPT priority...
        if(this.csrs[0x300] & 0b1000) { // ...and MSTATUS.MIE is set...
          this.updateMEICONTEXT_priority_save(); // this gets called ONLY on external interrupt trap
          this.trapEntry(((1<<31) | 11) >>> 0); //TODO hardwired cause MEIP = external interrupt
        }
        this.waiting = false; // "wfi ignores the global interrupt enable, MSTATUS.MIE"
      }
    }
  }

  trapEntry(mcause: number) {
    //this.logger.info(this.coreLabel, `Entering trap handler, mcause 0x${mcause.toString(16)}`);
    if(mcause != (((1<<31) | 11) >>> 0)) this.csrs[0xbe5] &= ~1; // clear MIECONTEXT.MRETEIRQ on any trap that's not an external interrupt
    this.setCSR(0x341, this.pc, 0); // Save the address of the interrupted or excepting instruction to MEPC
    // 2. Set the MSB of MCAUSE to indicate the cause is an interrupt, or clear it to indicate an exception
    // 3. Write the detailed trap cause to the LSBs of the MCAUSE register
    this.setCSR(0x342, mcause, 0);
    // TODO 4. Save the current privilege level to MSTATUS.MPP
    // TODO 5. Set the privilege to M-mode (note Hazard3 does not implement S-mode)
    // 6. Save the current value of MSTATUS.MIE to MSTATUS.MPIE
    let mstatus = this.getCSR(0x300, 0);
    mstatus &= ~0b10000000; mstatus |= (mstatus << 4) & 0b10000000;
    // 7. Disable interrupts by clearing MSTATUS.MIE
    mstatus &= 1<<7;
    this.setCSR(0x300, mstatus, 0);
    // 8. Jump to the correct offset from MTVEC depending on the trap cause
    const mtvec = this.getCSR(0x305, 0);
    if(mcause >> 31) {
      if((mtvec & 1) == 0) {
        this.pc = mtvec; // direct mtvec mode
      } else {
        this.pc = (mtvec & ~0b11) + ((mcause & 0b1111) << 2); // vectored mtvec mode
      }
    } else {
      this.pc = mtvec; // "Exceptions jump to exactly the address of MTVEC"
    }
    this.next_pc = 0;
    this.cycles += 2;
  }

  // Hazard3 branch predictor
  private btb: number = -1;
  public h3_branch_cycles(taken: boolean) {
    const from_pc = this.pc;
    const to_pc = this.next_pc;
    const jumped_back = to_pc < from_pc;
    if(from_pc === this.btb) {
      if(taken && jumped_back) return; // predictor hit
      // known branch mispredicted
      this.btb = -1;
      this.cycles++;
      return;
    }
    if(taken) {
      this.cycles++;
      if(jumped_back) this.btb = from_pc; // new backwards branch
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

  setCSR(csr: number, value: number, raw_write: number) {
    // raw_write: instruction raw write value, used for Xh3irq interrupt array indices
    value >>>= 0; raw_write >>>= 0;
    switch(csr) {
      case 0x300:
          this.csrs[csr] = value;
          return;
      case 0x304: // MIE
          this.csrs[csr] = value;
          this.interruptsUpdated = true;
          return;
      case 0x301:
      case 0x30a:
      case 0x310:
      case 0x31a:
      case 0x323: case 0x324: case 0x325: case 0x326: case 0x327: case 0x328: case 0x329: case 0x32a: case 0x32b: case 0x32c: case 0x32d: case 0x32e: case 0x32f:
      case 0x330: case 0x331: case 0x332: case 0x333: case 0x334: case 0x335: case 0x336: case 0x337: case 0x338: case 0x339: case 0x33a: case 0x33b: case 0x33c: case 0x33d: case 0x33e: case 0x33f:
      case 0x343:
      case 0x3b8: case 0x3b9: case 0x3ba: case 0x3bb: case 0x3bc: case 0x3bd: case 0x3be: case 0x3bf:
          return;
      case 0x340:
      case 0x341:
      case 0x342:
          this.csrs[csr] = value;
          return;
      //TODO
      case 0xbe0: { // MEIEA
          let state = value >>> 16;
          for(let irq = (raw_write & 0b11111) * 16; irq < (raw_write & 0b11111) * 16 + 16; irq++) { this.setInterruptEnabled(irq, !!(state & 1)); state >>= 1; }
          return; }
      case 0xbe1: return; // MEIPA
      case 0xbe2: { // MEIFA
          let state = value >>> 16;
          for(let irq = (raw_write & 0b11111) * 16; irq < (raw_write & 0b11111) * 16 + 16; irq++) {
            this.meifa[irq] = state & 1;
            this.setInterrupt(irq, !!(state & 1));
            state >>= 1;
          }
          return; }
      case 0xbe3: { // MEIPRA
          let state = value >>> 16;
          for(let irq = (raw_write & 0b11111) * 4; irq < (raw_write & 0b11111) * 4 + 4; irq++) {
            this.meipra[irq] = state & 0b1111;
            if(this.meipa[irq]) {
              this.setInterrupt(irq, false);
              this.setInterrupt(irq, true);
            }
            state >>= 4;
          }
          return; }
      case 0xbe4: { // MEINEXT
          if(value & 1) { // MEINEXT.UPDATE set
            this.updateMEICONTEXT_update();
            this.updateMEINEXT();
            this.interruptsUpdated = true;
          }
          return; }
      case 0xbe5: // MEICONTEXT - note MTIESAVE/MSIESAVE/CLEARTS writes are a side effect of getCTS here
          this.csrs[csr] = value;
          this.updateMEINEXT();
          this.interruptsUpdated = true;
          return;
      //TODO
      case 0xc00:
      case 0xc02:
      case 0xc80:
      case 0xc82:
      case 0xf11: case 0xf12: case 0xf13: case 0xf14:
          return;
    }
    this.logger.info(this.coreLabel, `Unknown CSR set: 0x${value.toString(16)} => 0x${csr.toString(16)}`);
    this.csrs[csr] = value;
  }

  getCSR(csr: number, raw_write: number): number {
    raw_write >>>= 0;
    // raw_write: instruction raw write value, used for Xh3irq interrupt array indices
    // MSTATUS 0x300
    // MIE 0x304
    // MTVEC 0x305
    // MSCRATCH 0x340
    // MSLEEP 0xbf0
    switch(csr) {
      case 0xf14: return this.mhartid;
      case 0x300:
      case 0x301:
      case 0x302:
      case 0x303:
      case 0x304:
      case 0x305:
      case 0x340:
      case 0x341:
      case 0x342:
      case 0x343:
      case 0x344:
      case 0xbf0: return this.csrs[csr];
      case 0xbe0: return (this.meiea.slice((raw_write & 0b11111) * 16, (raw_write & 0b11111) * 16 + 16).reduceRight((acc, val) => (acc << 1) | val, 0) << 16) >>> 0;
      case 0xbe1: return (this.meipa.slice((raw_write & 0b11111) * 16, (raw_write & 0b11111) * 16 + 16).reduceRight((acc, val) => (acc << 1) | val, 0) << 16) >>> 0;
      case 0xbe2: return (this.meifa.slice((raw_write & 0b11111) * 16, (raw_write & 0b11111) * 16 + 16).reduceRight((acc, val) => (acc << 1) | val, 0) << 16) >>> 0;
      case 0xbe3: return (this.meipra.slice((raw_write & 0b11111) * 4, (raw_write & 0b11111) * 4 + 4).reduceRight((acc, val) => (acc << 4) | val, 0) << 16) >>> 0;
      case 0xbe4:
        const meinext = this.csrs[csr] >>> 0;
        if(!(meinext >> 31)) {
          // reading MEINEXT clears MEIFA bits
          this.meifa[(meinext >> 2) & 511] = 0;
        }
        return meinext;
      case 0xbe5:
        let meicontext = this.csrs[0xbe5];
        if(raw_write & 0b0010) { // write to CLEARTS
          meicontext &= ~0b1110;
          meicontext |= ((this.csrs[0x304] >>> 7) & 1) << 3; // MTIE
          meicontext |= ((this.csrs[0x304] >>> 3) & 1) << 2; // MSIE
          this.csrs[0x304] &= ~(0b10001000); // clear MIE.MTIE and MSIE
        } else {
          if(raw_write & 0b1000) this.csrs[0x304] |= 1<<7; // write to MTIESAVE: set MIE.MTIE
          if(raw_write & 0b0100) this.csrs[0x304] |= 1<<3; // write to MSIESAVE: set MIE.MSIE
        }
        return meicontext;
    }
    this.logger.info(this.coreLabel, `Unknown CSR get: 0x${csr.toString(16)}`);
    return this.csrs[csr];
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

    //console.log("FENCE not implemented");
  }],
]);

const opcode0x13func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => { // addi
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);

    const result = (rs1Value + imm) >>> 0; // make sure 0x80000000 - 1 works

    registerSet.setRegisterU(rd, result);
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
    } else if (immU === 0b011000000100) { // sext.b (Zbb)
      const rs1Value = registerSet.getRegisterU(rs1);
      const value = signExtend8(rs1Value & 0xff);
      registerSet.setRegister(rd, value);
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

  [0x2, (instruction: I_Type, cpu: CPU) => { // slti
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    const result = rs1Value < imm ? 1 : 0;
    registerSet.setRegister(rd, result);
  }],

  [0x3, (instruction: I_Type, cpu: CPU) => { // sltiu
    const { rd, rs1, immU } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);

    const result = rs1Value < immU ? 1 : 0;
    registerSet.setRegister(rd, result);
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

    } else if (func7 === 0x34) { // rev8 (Zbb)
      const result = (rs1Value >>> 24) | ((rs1Value >>> 8) & 0xff00) | ((rs1Value << 8) & 0xff0000) | (((rs1Value & 0xff) << 24) >>> 0);
      registerSet.setRegisterU(rd, result >>> 0);

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
      cpu.cycles += 3;
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
      const result = (rs1Value * rs2Value / 0x100000000) >>> 0;
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
    } else if(func7 === 0x20) { // XNOR (Zbb)
      const result = (~rs1Value) ^ rs2Value;
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
      cpu.cycles += 17;
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
    } else if(func7 === 0x5) { // MAXU (Zbb)
      const result = (rs1Value >>> 0) > (rs2Value >>> 0) ? rs1Value : rs2Value;
      registerSet.setRegister(rd, result);
    } else if(func7 === 0x1) { // REMU (RV32M)
      const result = (rs2Value === 0) ? rs1Value : (rs1Value % rs2Value);
      registerSet.setRegister(rd, result);
      cpu.cycles += 17;
    } else throw Error(`Unknown instruction, func7: 0x${func7.toString(16)}`);
  }],

]);

const opcode0x63func3Table: FuncTable<B_Type> = new Map([
  [0x0, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const do_branch = rs1Value === rs2Value;
    if (do_branch) {
      cpu.next_pc = cpu.pc + imm;
    }
    cpu.h3_branch_cycles(do_branch);
  }],

  [0x1, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const do_branch = rs1Value !== rs2Value;
    if (do_branch) {
      cpu.next_pc = cpu.pc + imm;
    }
    cpu.h3_branch_cycles(do_branch);
  }],

  [0x4, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const do_branch = rs1Value < rs2Value;
    if (do_branch) {
      cpu.next_pc = cpu.pc + imm;
    }
    cpu.h3_branch_cycles(do_branch);
  }],

  [0x5, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);
    const rs2Value = registerSet.getRegister(rs2);

    const do_branch = rs1Value >= rs2Value;
    if (do_branch) {
      cpu.next_pc = cpu.pc + imm;
    }
    cpu.h3_branch_cycles(do_branch);
  }],

  [0x6, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    const do_branch = rs1Value < rs2Value;
    if (do_branch) {
      cpu.next_pc = cpu.pc + imm;
    }
    cpu.h3_branch_cycles(do_branch);
  }],

  [0x7, (instruction: B_Type, cpu: CPU) => {
    const { rs1, rs2, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegisterU(rs1);
    const rs2Value = registerSet.getRegisterU(rs2);

    const do_branch = rs1Value >= rs2Value;
    if (do_branch) {
      cpu.next_pc = cpu.pc + imm;
    }
    cpu.h3_branch_cycles(do_branch);
  }],
]);

const opcode0x67func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    const { rd, rs1, imm } = instruction;
    const { registerSet } = cpu;

    const rs1Value = registerSet.getRegister(rs1);

    registerSet.setRegister(rd, cpu.pc + cpu.inst_length);
    cpu.next_pc = rs1Value + imm;
    cpu.cycles++;
  }]
]);

const opcode0x73func3Table: FuncTable<I_Type> = new Map([
  [0x0, (instruction: I_Type, cpu: CPU) => {
    let mstatus = 0;
    switch(instruction.binary) {
      case 0x30200073: // mret
        // TODO Restore core privilege level to the value of MSTATUS.MPP
        mstatus = cpu.getCSR(0x300, 0);
        mstatus &= ~(3<<11); // Write 0 (U-mode) to MSTATUS.MPP
        mstatus &= ~0b1000; mstatus |= (mstatus >>> 4) & 0b1000; // Restore MSTATUS.MIE from MSTATUS.MPIE
        mstatus |= 1<<7; // Write 1 to MSTATUS.MPIE
        cpu.setCSR(0x300, mstatus, 0);
        cpu.next_pc = cpu.getCSR(0x341, 0); // Jump to the address in MEPC.
        cpu.cycles++;
        cpu.updateMEICONTEXT_priority_restore(); // Xh3irq
        cpu.interruptsUpdated = true;
        break;
      case 0x73: // ecall
        const u_mode = 0; //TODO
        const reason = u_mode?0x8:0xb;
        cpu.trapEntry(reason);
        break;
      default:
        throw Error(`Unknown instruction 0x${instruction.binary.toString(16)}`);
    }
  }],
  [0x1, (instruction: I_Type, cpu: CPU) => { // csrrw, csrw
    const { rd, rs1, immU } = instruction; // immU is csr
    const { registerSet } = cpu;
    const newValue = registerSet.getRegister(rs1);
    if(rd != 0) {
      const oldValue = cpu.getCSR(immU, newValue);
      registerSet.setRegister(rd, oldValue);
    }
    cpu.setCSR(immU, newValue, newValue);
  }],
  [0x2, (instruction: I_Type, cpu: CPU) => { // csrrs, csrs, csrr
    const { rd, rs1, immU } = instruction; // immU is csr
    const { registerSet } = cpu;
    const orValue = registerSet.getRegister(rs1);
    const oldValue = cpu.getCSR(immU, orValue);
    if(rs1 != 0) {
      const newValue = oldValue | orValue;
      cpu.setCSR(immU, newValue, orValue);
    }
    registerSet.setRegister(rd, oldValue);
  }],
  [0x3, (instruction: I_Type, cpu: CPU) => { // csrrc, csrc
    const { rd, rs1, immU } = instruction; // immU is csr
    const { registerSet } = cpu;
    const notValue = registerSet.getRegister(rs1);
    const oldValue = cpu.getCSR(immU, notValue);
    const newValue = oldValue & (~notValue);
    if(notValue != 0) {
      cpu.setCSR(immU, newValue, notValue);
    }
    registerSet.setRegister(rd, oldValue);
  }],
  [0x5, (instruction: I_Type, cpu: CPU) => { // csrwi
    const { rd, rs1, immU } = instruction; // rs1 is imm, immU is csr
    const { registerSet } = cpu;
    const newValue = rs1;
    if(rd != 0) {
      const oldValue = cpu.getCSR(immU, newValue);
      registerSet.setRegister(rd, oldValue);
    }
    cpu.setCSR(immU, newValue, newValue);
  }],
  [0x6, (instruction: I_Type, cpu: CPU) => { // csrrsi, csrsi
    const { rd, rs1, immU } = instruction; // rs1 is imm, immU is csr
    const { registerSet } = cpu;
    const oldValue = cpu.getCSR(immU, rs1);
    if(rs1 != 0) {
      const newValue = oldValue | rs1;
      cpu.setCSR(immU, newValue, rs1);
    }
    registerSet.setRegister(rd, oldValue);
  }],
  [0x7, (instruction: I_Type, cpu: CPU) => { // csrrci, csrci
    const { rd, rs1, immU } = instruction; // rs1 is imm, immU is csr
    const { registerSet } = cpu;
    const oldValue = cpu.getCSR(immU, rs1);
    if(rs1 != 0) {
      const newValue = oldValue & (~rs1);
      cpu.setCSR(immU, newValue, rs1);
    }
    registerSet.setRegister(rd, oldValue);
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
    const { rd, immU } = instruction;
    const { registerSet } = cpu;

    registerSet.setRegisterU(rd, immU);
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
    cpu.cycles++;
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
