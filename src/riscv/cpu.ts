import { ICpuCore } from '../cpu-core';
import type { RP2350 } from '../rp2350';
import { decodeWord } from './decode';
import { getDecodeEntry } from './decode-cache';
import { Uint32, Int53 } from '../utils/types';

// ─── Deliberately local, do not import these ───────────────────────
// Every module format this ships in (tsc CJS, tsc ESM, esbuild) compiles an
// imported binding to a property access on the exporting module. Local copy of
// utils/types.ts's helper so the hot path calls a function directly.

function int53High(packed: number): number {
  return Math.floor(packed / 4294967296) | 0;
}

// Tag values, duplicated from decode.ts for the same reason and with more at
// stake: a `switch` whose case labels are property accesses rather than literals
// cannot compile to a jump table, so all 173 of the ones below would degrade to a
// linear chain of module lookups per dispatch — measured 14.6x slower under Node.
// decode-tags.spec.ts fails the build if these drift from decode.ts.
const T_INVALID = 0;
const T_LB = 1;
const T_LH = 2;
const T_LW = 3;
const T_LBU = 4;
const T_LHU = 5;
const T_FENCE = 6;
const T_ADDI = 7;
const T_SLLI = 8;
const T_BSETI = 9;
const T_BCLRI = 10;
const T_BINVI = 11;
const T_CTZ = 12;
const T_CPOP = 13;
const T_SEXT_H = 14;
const T_SEXT_B = 15;
const T_CLZ = 16;
const T_ZIP = 17;
const T_UNZIP = 18;
const T_SLTI = 19;
const T_SLTIU = 20;
const T_XORI = 21;
const T_ORI = 22;
const T_ANDI = 23;
const T_SRLI = 24;
const T_SRAI = 25;
const T_BEXTI = 26;
const T_RORI = 27;
const T_REV8 = 28;
const T_BREV8 = 29;
const T_ORC_B = 30;
const T_ZEXT_H = 31;
const T_SB = 32;
const T_SH = 33;
const T_SW = 34;
const T_LR_W = 35;
const T_SC_W = 36;
const T_AMOADD_W = 37;
const T_AMOSWAP_W = 38;
const T_AMOXOR_W = 39;
const T_AMOOR_W = 40;
const T_AMOAND_W = 41;
const T_AMOMIN_W = 42;
const T_AMOMAX_W = 43;
const T_AMOMINU_W = 44;
const T_AMOMAXU_W = 45;
const T_ADD = 46;
const T_SUB = 47;
const T_MUL = 48;
const T_SLL = 49;
const T_MULH = 50;
const T_BSET = 51;
const T_BCLR = 52;
const T_ROL = 53;
const T_BINV = 54;
const T_SLT = 55;
const T_MULHSU = 56;
const T_SH1ADD = 57;
const T_SLTU = 58;
const T_MULHU = 59;
const T_XOR = 60;
const T_DIV = 61;
const T_SH2ADD = 62;
const T_PACK = 63;
const T_MIN = 64;
const T_XNOR = 65;
const T_SRL = 66;
const T_MINU = 67;
const T_SRA = 68;
const T_BEXT = 69;
const T_ROR = 70;
const T_DIVU = 71;
const T_OR = 72;
const T_REM = 73;
const T_MAX = 74;
const T_ORN = 75;
const T_SH3ADD = 76;
const T_AND = 77;
const T_ANDN = 78;
const T_PACKH = 79;
const T_MAXU = 80;
const T_REMU = 81;
const T_H3_BLOCK = 82;
const T_H3_UNBLOCK = 83;
const T_LUI = 84;
const T_AUIPC = 85;
const T_BEQ = 86;
const T_BNE = 87;
const T_BLT = 88;
const T_BGE = 89;
const T_BLTU = 90;
const T_BGEU = 91;
const T_JALR = 92;
const T_JAL = 93;
const T_MRET = 94;
const T_ECALL = 95;
const T_EBREAK = 96;
const T_WFI = 97;
const T_CSRRW = 98;
const T_CSRRS = 99;
const T_CSRRC = 100;
const T_CSRWI = 101;
const T_CSRRSI = 102;
const T_CSRRCI = 103;
const T_H3_BEXTM = 104;
const T_H3_BEXTMI = 105;
const T_CM_PUSH = 106;
const T_CM_POP = 107;
const T_CM_POPRETZ = 108;
const T_CM_POPRET = 109;
const T_CM_MVSA01 = 110;
const T_CM_MVA01S = 111;

// Zcmp register-list and stack-adjacency tables, moved from rv32c.ts (deleted).
// Indexed by the 4-bit rlist field of cm.push / cm.pop / cm.popret / cm.popretz.
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

enum ExecutionModeRiscv {
  Mode_Machine,
  Mode_User,
}

/** Hazard3/RP2350 hardware reset vector address (fixed, not VTOR-relative). */
export const RISCV_RESET_VECTOR = 0x7dfc;

export class CPU implements ICpuCore {
  public waiting = false;
  /** True when `waiting` is due to h3.block rather than wfi. An unblock
   * signal ends only a block sleep, never a wfi sleep (hazard3_power_ctrl.v:
   * sleeping_on_wfi wakes on wfi_wakeup_req alone). */
  public waitingOnBlock = false;
  public eventRegistered = false;

  readonly regs = new Int32Array(32);
  readonly csrs = new Uint32Array(0x1000);
  pc = 0;
  next_pc = 0;
  cycles: Int53 = 0; // avoids int32_t overflow past ~2.15B cycles
  currentMode: ExecutionModeRiscv = ExecutionModeRiscv.Mode_Machine;

  getRegister(index: number): number {
    return this.regs[index];
  }

  getRegisterU(index: number): Uint32 {
    return this.regs[index] >>> 0;
  }

  setRegister(index: number, value: number): void {
    // Identical to setRegisterU: Int32Array stores apply ToInt32, keeping all 32 bits.
    // x0 is hardwired to zero.
    if (index !== 0) this.regs[index] = value;
  }

  setRegisterU(index: number, value: number): void {
    if (index !== 0) this.regs[index] = value;
  }

  getCycles(): Int53 {
    return this.cycles;
  }

  addCycles(delta: number) {
    this.cycles += delta;
  }

  interruptsUpdated = false;
  meiea = new Array<number>(512);
  meipa = new Array<number>(512);
  meifa = new Array<number>(512);
  meipra = new Array<number>(512);
  // External-interrupt candidate list: the enabled+pending IRQs, kept sorted by
  // descending priority/ascending irq_number (see updateMEINEXT). Stored as two
  // fixed-capacity parallel Int32Arrays + a manual count, not a growable array —
  // cts2c has no `.sort()`/`.filter()` support, and `new Array<E>()` isn't the `[]`
  // literal shape its `.push()`-only growable support requires. 512 slots matches
  // meiea/meipa/meifa/meipra and is Hazard3's external-IRQ bound (can't overflow).
  // insertCandidate/removeCandidate below replace push+sort / filter.
  private candidateIrq = new Array<number>(512);
  private candidatePriority = new Array<number>(512);
  private candidateCount = 0;

  did_just_jump = false;

  // LR/SC reservation: -1 = no active reservation, otherwise the 16-byte
  // granule-aligned reservation address. lr.w sets it; sc.w checks it;
  // lr.w or AMO on the other hart to the same granule invalidates it.
  lr_addr = -1;
  // Sibling core (typed ICpuCore via the interface); the concrete CPU type
  // is kept so otherCore.invalidateLrReservation(...) stays callable, since
  // LR/SC reservation invalidation is a RISC-V-specific concern.
  otherCore!: CPU;

  setOtherCore(other: ICpuCore) {
    this.otherCore = other as unknown as CPU;
  }

  invalidateLrReservation(addr: number) {
    if (this.lr_addr === (addr & ~0xf)) this.lr_addr = -1;
  }

  // h3.unblock (SEV). RP2350 cross-wires each core's unblock output to the
  // other core AND loops it back to the sender (datasheet section 3.4), and
  // the signal is sticky: it ends an h3.block sleep, or arms the core's next
  // h3.block to fall through. It does NOT end a wfi sleep (only interrupts
  // do), but still latches for the next h3.block.
  fireSEV() {
    for (const core of [this, this.otherCore]) {
      if (core.waiting && core.waitingOnBlock) {
        core.waiting = false;
      } else {
        core.eventRegistered = true;
      }
    }
  }

  constructor(readonly chip: RP2350, readonly coreLabel: string, readonly mhartid: number) {
    this.reset();
  }

  get PC() {
    return this.pc;
  }

  set PC(value: number) {
    this.pc = value;
  }

  get coreIndex() {
    return this.mhartid;
  }

  get logger() {
    return this.chip.logger;
  }

  reset() {
    // Hazard3 hardware reset vector: fixed address, unlike ARM's VTOR table.
    this.pc = RISCV_RESET_VECTOR;
    // Clear parked wfi/wfe state, or a reset mid-wfi leaves the core frozen:
    // executeInstruction() checks `waiting` before fetching (matches
    // CortexM33Core.reset()'s equivalent).
    this.waiting = false;
    this.waitingOnBlock = false;
    this.eventRegistered = false;
    // TODO
    this.meiea.fill(0);
    this.meipa.fill(0);
    this.meifa.fill(0);
    this.meipra.fill(0);
    this.candidateCount = 0;
    this.interruptsUpdated = false;

    this.csrs.fill(0);
    this.csrs[0x300] = 3 << 11;
    this.csrs[0x301] = 0b01000000100100000001000100000101;
    this.csrs[0x305] = 0x00001fff00;
    this.csrs[0x320] = 0x101;
    //TODO 0x3a1 - 0x7b0
    this.csrs[0xbe4] = (1 << 31) >>> 0; // meinext: noirq
    this.csrs[0xbe5] = 1 << 15; // meicontext: noirq=1
    this.csrs[0xf11] = (0x9 << 7) | 0x13;
    this.csrs[0xf12] = 0x1b;
    this.csrs[0xf13] = 0x86fc4e3f;
  }

  inst_length = 0;

  // Packed decode entry for current instruction (see decode.ts for layout).
  curPacked: Int53 = 0;

  printDisassembly() {
    const pc = this.pc;
    if (this.chip.disassembly) {
      const search = (this.pc.toString(16) + ':').replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const re = new RegExp(search + '(.*)');
      const res = re.exec(this.chip.disassembly);
      const dis = res == null ? '?' : res[1];
      this.logger.info(this.coreLabel, `PC 0x${this.pc.toString(16)} - ${dis}`);
    } else {
      this.logger.info(this.coreLabel, `PC 0x${this.pc.toString(16)}`);
    }
  }

  executeInstruction(): number {
    const before = this.cycles;
    this.checkForInterrupts();
    if (this.waiting) {
      this.cycles++;
      return this.cycles - before;
    }
    this.curPacked = getDecodeEntry(this.chip, this.pc);
    try {
      this.executePacked();
    } catch (e) {
      this.printDisassembly();
      throw e;
    }
    this.cycles++;
    return this.cycles - before;
  }

  executeInstructionsUpTo(cycle: Int53) {
    // Parked in WFI: executeInstruction() would just tick `cycles` by one per call,
    // and nothing in this window can wake us — the other core isn't executing, and
    // peripherals/the clock only advance after the caller's catch-up loop returns.
    // So landing on `cycle` directly is exactly what the loop would have produced.
    // checkForInterrupts() still has to run once (executeInstruction() calls it
    // before testing `waiting`); it early-returns on `!interruptsUpdated` and clears
    // the flag, so the repeat calls the loop would have made were all no-ops anyway.
    this.checkForInterrupts();
    if (this.waiting) {
      if (this.cycles < cycle) {
        this.cycles = cycle;
      }
      return;
    }
    while (this.cycles < cycle) {
      this.executeInstruction();
    }
  }

  step(instruction: number) {
    this.curPacked = decodeWord(instruction >>> 0);
    this.executePacked();
  }

  // Run one instruction from curPacked. Extracts fields, sign-extends the
  // immediate to the width required by each instruction group, dispatches to
  // per-group methods, then runs the PC-update tail.
  //
  // Immediate encoding: decode.ts stores raw immediates masked to 21 bits in
  // the high part of the packed entry. Sign extension to the encoding width is
  // done HERE (in the dispatch) via arithmetic shifts, so exec methods receive
  // ready-to-use 32-bit signed values:
  //   I/S-type (12-bit):  sx12 = (imm << 20) >> 20
  //   B-type   (13-bit):  sx13 = (imm << 19) >> 19
  //   J-type   (21-bit):  sx21 = (imm << 11) >> 11
  //   U-type   (20-bit):  imm << 12 (always positive, just shift into place)
  private executePacked() {
    const packed = this.curPacked;
    const ops = packed >>> 0;
    const tag = (ops >>> 24) & 0xff;
    const r = (ops >>> 9) & 0x1f;
    const s1 = (ops >>> 14) & 0x1f;
    const s2 = (ops >>> 19) & 0x1f;
    const is32 = (ops >>> 8) & 1;
    const imm = int53High(packed); // raw 21-bit immediate
    if (is32 && this.pc & 3 && this.did_just_jump) this.cycles++;
    this.inst_length = is32 ? 4 : 2;

    switch (tag) {
      case T_INVALID:
        throw Error(`Illegal instruction 0 at 0x${this.pc.toString(16)}`);
      case T_LB:
      case T_LH:
      case T_LW:
      case T_LBU:
      case T_LHU:
        this.execLoad(tag, r, s1, (imm << 20) >> 20); // sx12
        break;
      case T_FENCE:
        break;
      case T_ADDI:
      case T_SLLI:
      case T_BSETI:
      case T_BCLRI:
      case T_BINVI:
      case T_CTZ:
      case T_CPOP:
      case T_SEXT_H:
      case T_SEXT_B:
      case T_CLZ:
      case T_ZIP:
      case T_UNZIP:
      case T_SLTI:
      case T_SLTIU:
      case T_XORI:
      case T_ORI:
      case T_ANDI:
      case T_SRLI:
      case T_SRAI:
      case T_BEXTI:
      case T_RORI:
      case T_REV8:
      case T_BREV8:
      case T_ORC_B:
      case T_ZEXT_H:
        this.execOpImm(tag, r, s1, (imm << 20) >> 20); // sx12
        break;
      case T_SB:
      case T_SH:
      case T_SW:
        this.execStore(tag, s1, s2, (imm << 20) >> 20); // sx12
        break;
      case T_LR_W:
      case T_SC_W:
      case T_AMOADD_W:
      case T_AMOSWAP_W:
      case T_AMOXOR_W:
      case T_AMOOR_W:
      case T_AMOAND_W:
      case T_AMOMIN_W:
      case T_AMOMAX_W:
      case T_AMOMINU_W:
      case T_AMOMAXU_W:
        this.execAmo(tag, r, s1, s2);
        break;
      case T_ADD:
      case T_SUB:
      case T_MUL:
      case T_SLL:
      case T_MULH:
      case T_BSET:
      case T_BCLR:
      case T_ROL:
      case T_BINV:
      case T_SLT:
      case T_MULHSU:
      case T_SH1ADD:
      case T_SLTU:
      case T_MULHU:
      case T_XOR:
      case T_DIV:
      case T_SH2ADD:
      case T_PACK:
      case T_MIN:
      case T_XNOR:
      case T_SRL:
      case T_MINU:
      case T_SRA:
      case T_BEXT:
      case T_ROR:
      case T_DIVU:
      case T_OR:
      case T_REM:
      case T_MAX:
      case T_ORN:
      case T_SH3ADD:
      case T_AND:
      case T_ANDN:
      case T_PACKH:
      case T_MAXU:
      case T_REMU:
        this.execOp(tag, r, s1, s2);
        break;
      case T_H3_BLOCK:
      case T_H3_UNBLOCK:
        this.execH3(tag);
        break;
      case T_LUI:
        this.setRegisterU(r, (imm << 12) >>> 0);
        break;
      case T_AUIPC:
        this.setRegister(r, (imm << 12) + this.pc);
        break;
      case T_BEQ:
      case T_BNE:
      case T_BLT:
      case T_BGE:
      case T_BLTU:
      case T_BGEU:
        this.execBranch(tag, s1, s2, (imm << 19) >> 19); // sx13
        break;
      case T_JALR: {
        const target = this.getRegister(s1) + ((imm << 20) >> 20); // sx12
        this.setRegister(r, this.pc + this.inst_length);
        this.next_pc = target;
        this.cycles++;
        break;
      }
      case T_JAL: {
        const link = this.pc + this.inst_length;
        this.setRegister(r, link);
        checkTraceMagic(this, link);
        this.next_pc = this.pc + ((imm << 11) >> 11); // sx21
        this.cycles++;
        break;
      }
      case T_MRET:
      case T_ECALL:
      case T_EBREAK:
      case T_WFI:
      case T_CSRRW:
      case T_CSRRS:
      case T_CSRRC:
      case T_CSRWI:
      case T_CSRRSI:
      case T_CSRRCI:
        this.execSystem(tag, r, s1, imm);
        break;
      case T_H3_BEXTM:
      case T_H3_BEXTMI:
        this.execCustom0(tag, r, s1, s2, imm);
        break;
      case T_CM_PUSH:
      case T_CM_POP:
      case T_CM_POPRETZ:
      case T_CM_POPRET:
      case T_CM_MVSA01:
      case T_CM_MVA01S:
        this.execZcmp(tag, r, s1, s2, imm);
        break;
      default:
        throw Error(`Unhandled tag ${tag} at PC 0x${this.pc.toString(16)}`);
    }

    if (this.next_pc != 0) {
      this.pc = this.next_pc;
      this.next_pc = 0;
      this.did_just_jump = true;
    } else {
      this.pc += this.inst_length;
      this.did_just_jump = false;
    }
  }

  private execLoad(tag: number, r: number, s1: number, imm: number) {
    const addr = this.getRegisterU(s1) + imm;
    if (tag === T_LB) this.setRegister(r, signExtend8(this.chip.readUint8(addr)));
    else if (tag === T_LH) this.setRegister(r, signExtend16(this.chip.readUint16(addr)));
    else if (tag === T_LW) this.setRegisterU(r, this.chip.readUint32(addr));
    else if (tag === T_LBU) this.setRegister(r, this.chip.readUint8(addr));
    else this.setRegister(r, this.chip.readUint16(addr));
  }

  private execStore(tag: number, s1: number, s2: number, imm: number) {
    const addr = this.getRegister(s1) + imm;
    const v = this.getRegister(s2);
    if (tag === T_SB) this.chip.writeUint8(addr, v & 0xff);
    else if (tag === T_SH) this.chip.writeUint16(addr, v & 0xffff);
    else this.chip.writeUint32(addr, v);
  }

  // imm is already sign-extended to 12 bits by executePacked.
  private execOpImm(tag: number, r: number, s1: number, imm: number) {
    switch (tag) {
      case T_ADDI:
        this.setRegisterU(r, (this.getRegisterU(s1) + imm) >>> 0);
        break;
      case T_SLLI:
        this.setRegisterU(r, this.getRegisterU(s1) << imm);
        break;
      case T_BSETI:
        this.setRegister(r, this.getRegister(s1) | (1 << imm));
        break;
      case T_BCLRI:
        this.setRegister(r, this.getRegister(s1) & ~(1 << imm));
        break;
      case T_BINVI:
        this.setRegister(r, this.getRegister(s1) ^ (1 << imm));
        break;
      case T_CTZ: {
        const t = this.getRegister(s1) >>> 0;
        this.setRegister(r, t === 0 ? 32 : 31 - Math.clz32(t & -t));
        break;
      }
      case T_CPOP: {
        let t = this.getRegister(s1) >>> 0;
        t = t - ((t >> 1) & 0x55555555);
        t = (t & 0x33333333) + ((t >> 2) & 0x33333333);
        this.setRegister(r, (((t + (t >> 4)) & 0xf0f0f0f) * 0x1010101) >> 24);
        break;
      }
      case T_SEXT_H:
        this.setRegister(r, signExtend16(this.getRegisterU(s1) & 0xffff));
        break;
      case T_SEXT_B:
        this.setRegister(r, signExtend8(this.getRegisterU(s1) & 0xff));
        break;
      case T_CLZ:
        this.setRegister(r, Math.clz32(this.getRegisterU(s1)));
        break;
      case T_ZIP: {
        const u = this.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 16; i++) {
          result |= ((u >>> (16 + i)) & 1) << (2 * i);
          result |= ((u >>> i) & 1) << (2 * i + 1);
        }
        this.setRegisterU(r, result >>> 0);
        break;
      }
      case T_UNZIP: {
        const u = this.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 16; i++) {
          result |= ((u >>> (2 * i + 1)) & 1) << i;
          result |= ((u >>> (2 * i)) & 1) << (16 + i);
        }
        this.setRegisterU(r, result >>> 0);
        break;
      }
      case T_SLTI:
        this.setRegister(r, this.getRegister(s1) < imm ? 1 : 0);
        break;
      case T_SLTIU:
        this.setRegister(r, this.getRegisterU(s1) < (imm & 0xfff) ? 1 : 0);
        break;
      case T_XORI:
        this.setRegister(r, this.getRegister(s1) ^ imm);
        break;
      case T_ORI:
        this.setRegister(r, this.getRegister(s1) | imm);
        break;
      case T_ANDI:
        this.setRegister(r, this.getRegister(s1) & imm);
        break;
      case T_SRLI:
        this.setRegister(r, this.getRegister(s1) >>> imm);
        break;
      case T_SRAI:
        this.setRegister(r, this.getRegister(s1) >> imm);
        break;
      case T_BEXTI:
        this.setRegister(r, (this.getRegister(s1) >>> imm) & 1);
        break;
      case T_RORI: {
        const u = this.getRegisterU(s1);
        this.setRegister(r, ((u << (32 - imm)) >>> 0) | (u >>> imm));
        break;
      }
      case T_REV8: {
        const v = this.getRegister(s1);
        this.setRegisterU(
          r,
          ((v >>> 24) |
            ((v >>> 8) & 0xff00) |
            ((v << 8) & 0xff0000) |
            (((v & 0xff) << 24) >>> 0)) >>>
            0
        );
        break;
      }
      case T_BREV8: {
        const u = this.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 32; i += 8) {
          let by = (u >>> i) & 0xff;
          by = ((by & 0xf0) >> 4) | ((by & 0x0f) << 4);
          by = ((by & 0xcc) >> 2) | ((by & 0x33) << 2);
          by = ((by & 0xaa) >> 1) | ((by & 0x55) << 1);
          result |= by << i;
        }
        this.setRegisterU(r, result >>> 0);
        break;
      }
      case T_ORC_B: {
        const u = this.getRegisterU(s1);
        let result = 0;
        for (let i = 0; i < 32; i += 8) {
          if (u & (0x80 << i)) result |= 0xff << i;
        }
        this.setRegisterU(r, result >>> 0);
        break;
      }
      case T_ZEXT_H:
        this.setRegisterU(r, this.getRegisterU(s1) & 0xffff);
        break;
    }
  }

  private execAmo(tag: number, r: number, s1: number, s2: number) {
    const addr = this.getRegisterU(s1);
    if (tag === T_LR_W) {
      this.setRegisterU(r, this.chip.readUint32(addr));
      this.lr_addr = addr & ~0xf;
      this.otherCore.invalidateLrReservation(addr);
      this.cycles += 3;
      return;
    }
    if (tag === T_SC_W) {
      if (this.lr_addr === (addr & ~0xf)) {
        this.chip.writeUint32(addr, this.getRegisterU(s2));
        this.setRegisterU(r, 0);
      } else {
        this.setRegisterU(r, 1);
      }
      this.lr_addr = -1;
      this.cycles += 3;
      return;
    }
    const v = this.getRegisterU(s2);
    const mem = this.chip.readUint32(addr);
    this.setRegisterU(r, mem);
    let sv: number;
    if (tag === T_AMOADD_W) sv = (mem + v) >>> 0;
    else if (tag === T_AMOSWAP_W) sv = v;
    else if (tag === T_AMOXOR_W) sv = mem ^ v;
    else if (tag === T_AMOOR_W) sv = mem | v;
    else if (tag === T_AMOAND_W) sv = mem & v;
    else if (tag === T_AMOMIN_W) sv = (mem | 0) < (v | 0) ? mem : v;
    else if (tag === T_AMOMAX_W) sv = (mem | 0) > (v | 0) ? mem : v;
    else if (tag === T_AMOMINU_W) sv = mem < v ? mem : v;
    else sv = mem > v ? mem : v;
    this.chip.writeUint32(addr, sv);
    this.otherCore.invalidateLrReservation(addr);
    this.cycles += 3;
  }

  private execOp(tag: number, r: number, s1: number, s2: number) {
    const a = this.getRegister(s1),
      b = this.getRegister(s2);
    switch (tag) {
      case T_ADD:
        this.setRegister(r, a + b);
        break;
      case T_SUB:
        this.setRegister(r, a - b);
        break;
      case T_MUL:
        this.setRegister(r, Math.imul(a, b));
        break;
      case T_SLL:
        this.setRegister(r, a << b);
        break;
      case T_MULH: {
        let hi = umulh(a >>> 0, b >>> 0);
        if (a < 0) hi = (hi - (b >>> 0)) | 0;
        if (b < 0) hi = (hi - (a >>> 0)) | 0;
        this.setRegister(r, hi);
        break;
      }
      case T_BSET:
        this.setRegister(r, a | (1 << (b & 31)));
        break;
      case T_BCLR:
        this.setRegister(r, a & ~(1 << (b & 31)));
        break;
      case T_ROL: {
        const sh = b & 31;
        this.setRegister(r, ((a << sh) | (a >>> (32 - sh))) >>> 0);
        break;
      }
      case T_BINV:
        this.setRegister(r, a ^ (1 << (b & 31)));
        break;
      case T_SLT:
        this.setRegister(r, a < b ? 1 : 0);
        break;
      case T_MULHSU: {
        const bu = b >>> 0;
        let hi = umulh(a >>> 0, bu);
        if (a < 0) hi = (hi - bu) | 0;
        this.setRegister(r, hi);
        break;
      }
      case T_SH1ADD:
        this.setRegister(r, ((a << 1) + b) & 0xffffffff);
        break;
      case T_SLTU:
        this.setRegister(r, a >>> 0 < b >>> 0 ? 1 : 0);
        break;
      case T_MULHU:
        this.setRegisterU(r, umulh(a >>> 0, b >>> 0));
        break;
      case T_XOR:
        this.setRegister(r, a ^ b);
        break;
      case T_DIV:
        if (b === 0) this.setRegisterU(r, 0xffffffff);
        else if (a >>> 0 === 0x80000000 && b >>> 0 === 0xffffffff) this.setRegisterU(r, 0x80000000);
        else this.setRegister(r, (a / b) | 0);
        this.cycles += 17;
        break;
      case T_SH2ADD:
        this.setRegister(r, ((a << 2) + b) & 0xffffffff);
        break;
      case T_PACK:
        this.setRegister(r, (a & 0xffff) | ((b & 0xffff) << 16));
        break;
      case T_MIN:
        this.setRegister(r, a < b ? a : b);
        break;
      case T_XNOR:
        this.setRegister(r, ~a ^ b);
        break;
      case T_SRL:
        this.setRegister(r, a >>> b);
        break;
      case T_MINU: {
        const u1 = a >>> 0,
          u2 = b >>> 0;
        this.setRegister(r, u1 < u2 ? u1 : u2);
        break;
      }
      case T_SRA:
        this.setRegister(r, a >> b);
        break;
      case T_BEXT:
        this.setRegister(r, (a >>> (b & 31)) & 1);
        break;
      case T_ROR: {
        const sh = b & 31;
        const u = a >>> 0;
        this.setRegister(r, ((u << (32 - sh)) >>> 0) | (u >>> sh));
        break;
      }
      case T_DIVU:
        if (b === 0) this.setRegisterU(r, 0xffffffff);
        else this.setRegister(r, ((a >>> 0) / (b >>> 0)) >>> 0);
        this.cycles += 17;
        break;
      case T_OR:
        this.setRegister(r, a | b);
        break;
      case T_REM:
        this.setRegister(r, b === 0 ? a : a % b);
        this.cycles += 17;
        break;
      case T_MAX:
        this.setRegister(r, a > b ? a : b);
        break;
      case T_ORN:
        this.setRegister(r, a | ~b);
        break;
      case T_SH3ADD:
        this.setRegister(r, ((a << 3) + b) & 0xffffffff);
        break;
      case T_AND:
        this.setRegister(r, a & b);
        break;
      case T_ANDN:
        this.setRegister(r, a & ~b);
        break;
      case T_PACKH:
        this.setRegister(r, (a & 0xff) | ((b & 0xff) << 8));
        break;
      case T_MAXU: {
        const u1 = a >>> 0,
          u2 = b >>> 0;
        this.setRegisterU(r, (u1 > u2 ? u1 : u2) >>> 0);
        break;
      }
      case T_REMU:
        this.setRegisterU(r, (b === 0 ? a : (a >>> 0) % (b >>> 0)) >>> 0);
        this.cycles += 17;
        break;
    }
  }

  private execH3(tag: number) {
    if (tag === T_H3_BLOCK) {
      if (this.eventRegistered) this.eventRegistered = false;
      else if (this.wakingInterruptPending()) this.interruptsUpdated = true;
      else {
        this.waiting = true;
        this.waitingOnBlock = true;
      }
    } else this.fireSEV();
  }

  private execBranch(tag: number, s1: number, s2: number, imm: number) {
    let taken = false;
    if (tag === T_BEQ) taken = this.getRegister(s1) === this.getRegister(s2);
    else if (tag === T_BNE) taken = this.getRegister(s1) !== this.getRegister(s2);
    else if (tag === T_BLT) taken = this.getRegister(s1) < this.getRegister(s2);
    else if (tag === T_BGE) taken = this.getRegister(s1) >= this.getRegister(s2);
    else if (tag === T_BLTU) taken = this.getRegisterU(s1) < this.getRegisterU(s2);
    else taken = this.getRegisterU(s1) >= this.getRegisterU(s2);
    if (taken) this.next_pc = this.pc + imm;
    this.h3_branch_cycles(taken);
  }

  private execSystem(tag: number, r: number, s1: number, imm: number) {
    if (tag === T_MRET) {
      let mstatus = this.getCSR(0x300, 0);
      mstatus &= ~(3 << 11);
      mstatus &= ~0b1000;
      mstatus |= (mstatus >>> 4) & 0b1000;
      mstatus |= 1 << 7;
      this.setCSR(0x300, mstatus, 0);
      this.next_pc = this.getCSR(0x341, 0);
      this.cycles++;
      this.updateMEICONTEXT_priority_restore();
      this.interruptsUpdated = true;
    } else if (tag === T_ECALL) this.trapEntry(0xb, true);
    else if (tag === T_EBREAK) this.trapEntry(3, true);
    else if (tag === T_WFI) {
      if (this.wakingInterruptPending()) this.interruptsUpdated = true;
      else {
        this.waiting = true;
        this.waitingOnBlock = false;
      }
    } else if (tag === T_CSRRW) {
      const csr = imm & 0xfff;
      const newVal = this.getRegister(s1);
      if (r !== 0) this.setRegister(r, this.getCSR(csr, newVal));
      this.setCSR(csr, newVal, newVal);
    } else if (tag === T_CSRRS) {
      const csr = imm & 0xfff;
      const orVal = this.getRegister(s1);
      const old = this.getCSR(csr, orVal);
      if (s1 !== 0) this.setCSR(csr, old | orVal, orVal);
      this.setRegister(r, old);
    } else if (tag === T_CSRRC) {
      const csr = imm & 0xfff;
      const notVal = this.getRegister(s1);
      const old = this.getCSR(csr, notVal);
      if (notVal !== 0) this.setCSR(csr, old & ~notVal, notVal);
      this.setRegister(r, old);
    } else {
      const csr = (imm >>> 5) & 0xfff;
      const imm5 = imm & 0x1f;
      if (tag === T_CSRWI) {
        if (r !== 0) this.setRegister(r, this.getCSR(csr, imm5));
        this.setCSR(csr, imm5, imm5);
      } else if (tag === T_CSRRSI) {
        const old = this.getCSR(csr, imm5);
        if (imm5 !== 0) this.setCSR(csr, old | imm5, imm5);
        this.setRegister(r, old);
      } else {
        const old = this.getCSR(csr, imm5);
        if (imm5 !== 0) this.setCSR(csr, old & ~imm5, imm5);
        this.setRegister(r, old);
      }
    }
  }

  private execCustom0(tag: number, r: number, s1: number, s2: number, imm: number) {
    const size = (imm >>> 1) & 0b111;
    const sh = tag === T_H3_BEXTM ? this.getRegisterU(s2) : s2;
    this.setRegisterU(r, (this.getRegisterU(s1) >>> sh) & ((2 << size) - 1));
  }

  private execZcmp(tag: number, r: number, s1: number, s2: number, imm: number) {
    if (tag === T_CM_PUSH) {
      const stack_adj = stack_adj_base[s2] + imm;
      const sp = this.getRegisterU(2);
      let addr = sp - 4;
      for (const reg of xreg_list[s2]) {
        this.chip.writeUint32(addr, this.getRegisterU(reg));
        addr -= 4;
        this.cycles++;
      }
      this.setRegisterU(2, sp - stack_adj);
    } else if (tag === T_CM_POP || tag === T_CM_POPRETZ || tag === T_CM_POPRET) {
      const stack_adj = stack_adj_base[s2] + imm;
      const sp = this.getRegisterU(2);
      let addr = sp + stack_adj - 4;
      for (const reg of xreg_list[s2]) {
        this.setRegisterU(reg, this.chip.readUint32(addr));
        addr -= 4;
        this.cycles++;
      }
      this.setRegisterU(2, sp + stack_adj);
      if (tag === T_CM_POPRETZ) this.setRegister(10, 0);
      if (tag === T_CM_POPRET || tag === T_CM_POPRETZ) {
        this.next_pc = this.getRegister(1);
        this.cycles++;
      }
    } else {
      this.setRegister(r, this.getRegister(s2));
      this.setRegister(s1, this.getRegister(imm));
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

  // Insertion-sort step: maintain descending-priority/ascending-irq_number order by
  // shifting lower-priority (or equal-priority/higher-irq_number) entries right, then
  // drop the new entry into the gap. setInterrupt only calls this for an irq not
  // already present (guarded by `!this.meipa[irq]` at the call site, cleared before
  // re-insert), so no duplicate handling is needed.
  private insertCandidate(irq: number, priority: number) {
    let i = this.candidateCount;
    while (
      i > 0 &&
      (this.candidatePriority[i - 1] < priority ||
        (this.candidatePriority[i - 1] === priority && this.candidateIrq[i - 1] > irq))
    ) {
      this.candidatePriority[i] = this.candidatePriority[i - 1];
      this.candidateIrq[i] = this.candidateIrq[i - 1];
      i--;
    }
    this.candidatePriority[i] = priority;
    this.candidateIrq[i] = irq;
    this.candidateCount++;
  }

  // Remove `irq` if present, preserving the order of the rest (in-place tail shift,
  // like `.filter(...)` without allocating). At most one entry can match — the meipa
  // flag guarantees an irq is never in the list twice (see insertCandidate).
  private removeCandidate(irq: number) {
    let at = -1;
    for (let i = 0; i < this.candidateCount; i++) {
      if (this.candidateIrq[i] === irq) {
        at = i;
        break;
      }
    }
    if (at === -1) return;
    for (let i = at; i < this.candidateCount - 1; i++) {
      this.candidatePriority[i] = this.candidatePriority[i + 1];
      this.candidateIrq[i] = this.candidateIrq[i + 1];
    }
    this.candidateCount--;
  }

  setInterrupt(irq: number, value: boolean) {
    //this.logger.warn(this.coreLabel, `New interrupt: ${irq} = ${value}`);
    if (value && !this.meipa[irq]) {
      this.meipa[irq] = 1; // Spec: meipa = irq_r | meifa, unconditional on meiea
      if (this.meiea[irq]) {
        // Only add to candidate list if the IRQ is enabled
        this.insertCandidate(irq, this.meipra[irq]);
        this.updateMEINEXT();
        this.interruptsUpdated = true;
      }
    } else if (!value && this.meipa[irq]) {
      this.meipa[irq] = 0;
      this.removeCandidate(irq);
      this.updateMEINEXT();
    }
  }

  updateMEINEXT() {
    // updates MEINEXT and MIE.MEIP
    const meicontext_ppreempt = (this.csrs[0xbe5] >>> 24) & 0b1111;
    if (this.candidateCount > 0 && this.candidatePriority[0] >= meicontext_ppreempt) {
      // note that we're looking at *PP*REEMPT here - interrupts with equal or higher priority than that ARE visible in MEINEXT
      // but might still NOT trigger a trap in case their priority is lower than *P*REEMPT.
      this.csrs[0xbe4] = this.candidateIrq[0] << 2;
      this.csrs[0x344] |= 1 << 11;
    } else {
      this.csrs[0xbe4] = (1 << 31) >>> 0;
      this.csrs[0x344] &= ~(1 << 11);
    }
  }

  updateMEICONTEXT_update() {
    // called on MEINEXT.UPDATE write
    let meicontext = this.csrs[0xbe5];
    const meinext = this.csrs[0xbe4] >>> 0;
    const noirq = meinext >> 31;
    // clear NOIRQ, IRQ, and PREEMPT
    meicontext &= ~((0b1 << 15) | (0x1ff << 4) | (0x1f << 16));
    // update NOIRQ
    meicontext |= noirq << 15;
    // update IRQ and PREEMPT
    if (!noirq) {
      const current_irq = (meinext >>> 2) & 511;
      meicontext |= current_irq << 4;
      // Spec: preempt_level_next = 1 + priority (for IRQ_PRIORITY_BITS=4)
      meicontext |= (this.meipra[current_irq] + 1) << 16;
    } else {
      meicontext |= 16 << 16; // no preemption when noirq
    }
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
    const meinext = this.csrs[0xbe4] >>> 0;
    if (!(meinext >> 31)) {
      // Valid IRQ: preempt = 1 + priority (IRQ_PRIORITY_BITS=4)
      const current_irq = (meinext >>> 2) & 511;
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
    if (!(meicontext & 1)) return; // only proceed if MRETEIRQ is set
    // clear PPP/PP/PREEMPT/MRETEIRQ
    meicontext &= 0b111111111111110;
    // set PPREEMPT from old PPPREEMPT
    meicontext |= (this.csrs[0xbe5] >>> 28) << 24;
    // set PREEMPT from old PPREEMPT
    meicontext |= ((this.csrs[0xbe5] >>> 24) & 0b1111) << 16;
    this.csrs[0xbe5] = meicontext;
  }

  /** wfi/h3.block wake condition: an enabled external interrupt at or above
   * the current preemption level, regardless of MSTATUS.MIE. */
  wakingInterruptPending(): boolean {
    if (!(this.csrs[0x304] & 0b100000000000)) return false;
    // if MIE.MEIE is set... TODO consider software and timer interrupts as well
    const meinext = this.csrs[0xbe4] >>> 0;
    const meinext_noirq = meinext >> 31;
    const meinext_irq_number = (meinext >>> 2) & 511;
    const meinext_irq_prio = this.meipra[meinext_irq_number];
    const meicontext_preempt = (this.csrs[0xbe5] >>> 16) & 0b11111;
    // ...and the interrupt visible in MEINEXT has at least PREEMPT priority.
    return !meinext_noirq && meinext_irq_prio >= meicontext_preempt;
  }

  // Called between instructions only (mepc must be the next instruction; a
  // trap from inside step() would also have its target clobbered by the
  // post-step PC update). wfi/h3.block instead fall through on a pending
  // interrupt and leave the trap to the next checkForInterrupts(), which per
  // the RISC-V priv spec is exactly "the interrupt trap will be taken on the
  // following instruction".
  resolveWakingInterrupt(): boolean {
    if (!this.wakingInterruptPending()) return false;
    if (this.csrs[0x300] & 0b1000) {
      // ...and MSTATUS.MIE is set...
      this.updateMEICONTEXT_priority_save(); // this gets called ONLY on external interrupt trap
      this.trapEntry(((1 << 31) | 11) >>> 0); //TODO hardwired cause MEIP = external interrupt
    }
    this.waiting = false; // "wfi ignores the global interrupt enable, MSTATUS.MIE"
    return true;
  }

  checkForInterrupts() {
    if (!this.interruptsUpdated) return;
    this.interruptsUpdated = false;
    this.resolveWakingInterrupt();
  }

  trapEntry(mcause: number, fromStep: boolean = false) {
    //this.logger.info(this.coreLabel, `Entering trap handler, mcause 0x${mcause.toString(16)}`);
    if (mcause != ((1 << 31) | 11) >>> 0) this.csrs[0xbe5] &= ~1; // clear MIECONTEXT.MRETEIRQ on any trap that's not an external interrupt
    this.setCSR(0x341, this.pc, 0); // Save the address of the interrupted or excepting instruction to MEPC
    // 2. Set the MSB of MCAUSE to indicate the cause is an interrupt, or clear it to indicate an exception
    // 3. Write the detailed trap cause to the LSBs of the MCAUSE register
    this.setCSR(0x342, mcause, 0);
    // TODO 4. Save the current privilege level to MSTATUS.MPP
    // TODO 5. Set the privilege to M-mode (note Hazard3 does not implement S-mode)
    // 6. Save the current value of MSTATUS.MIE to MSTATUS.MPIE
    let mstatus = this.getCSR(0x300, 0);
    mstatus &= ~0b10000000;
    mstatus |= (mstatus << 4) & 0b10000000;
    // 7. Disable interrupts by clearing MSTATUS.MIE
    mstatus &= ~(1 << 3);
    this.setCSR(0x300, mstatus, 0);
    // 8. Jump to the correct offset from MTVEC depending on the trap cause.
    // For synchronous exceptions (ecall/ebreak during step), set next_pc so the
    // post-step PC-update logic redirects without adding inst_length. For
    // asynchronous interrupts (checkForInterrupts before fetch), set pc directly.
    // Trap target: (mtvec & ~3) | (vector_sel << 2), where vector_sel is 0 for
    // exceptions and direct-mode interrupts (hazard3_csr.v, mtvec wire).
    const mtvec = this.getCSR(0x305, 0);
    let target: number;
    if (mcause >> 31 && mtvec & 1) {
      target = (mtvec & ~0b11) | ((mcause & 0b1111) << 2); // vectored interrupt
    } else {
      target = mtvec & ~0b11; // exception or direct-mode interrupt
    }
    if (fromStep) {
      this.next_pc = target;
    } else {
      this.pc = target;
      this.next_pc = 0;
    }
    this.cycles += 2;
  }

  // Hazard3 branch predictor
  private btb: number = -1;
  public h3_branch_cycles(taken: boolean) {
    const from_pc = this.pc;
    const to_pc = this.next_pc;
    const jumped_back = to_pc < from_pc;
    if (from_pc === this.btb) {
      if (taken && jumped_back) return; // predictor hit
      // known branch mispredicted
      this.btb = -1;
      this.cycles++;
      return;
    }
    if (taken) {
      this.cycles++;
      if (jumped_back) this.btb = from_pc; // new backwards branch
    }
  }

  setCSR(csr: number, value: number, raw_write: number) {
    // raw_write: instruction raw write value, used for Xh3irq interrupt array indices
    value >>>= 0;
    raw_write >>>= 0;
    switch (csr) {
      case 0x300: // MSTATUS
        if (value & ~this.csrs[csr] & 0b1000) this.interruptsUpdated = true; // MSTATUS.MIE has been set
        this.csrs[csr] = value;
        return;
      case 0x305: // MTVEC
        this.csrs[csr] = value;
        return;
      case 0x304: // MIE
        if (value & ~this.csrs[csr]) this.interruptsUpdated = true; // any bit in MIE has been set
        this.csrs[csr] = value;
        return;
      case 0x301:
      case 0x30a:
      case 0x310:
      case 0x31a:
      case 0x323:
      case 0x324:
      case 0x325:
      case 0x326:
      case 0x327:
      case 0x328:
      case 0x329:
      case 0x32a:
      case 0x32b:
      case 0x32c:
      case 0x32d:
      case 0x32e:
      case 0x32f:
      case 0x330:
      case 0x331:
      case 0x332:
      case 0x333:
      case 0x334:
      case 0x335:
      case 0x336:
      case 0x337:
      case 0x338:
      case 0x339:
      case 0x33a:
      case 0x33b:
      case 0x33c:
      case 0x33d:
      case 0x33e:
      case 0x33f:
      case 0x343:
      case 0x3b8:
      case 0x3b9:
      case 0x3ba:
      case 0x3bb:
      case 0x3bc:
      case 0x3bd:
      case 0x3be:
      case 0x3bf:
        return;
      case 0x340:
      case 0x341:
      case 0x342:
        this.csrs[csr] = value;
        return;
      //TODO
      case 0xbe0: {
        // MEIEA
        let state = value >>> 16;
        for (let irq = (raw_write & 0b11111) * 16; irq < (raw_write & 0b11111) * 16 + 16; irq++) {
          this.setInterruptEnabled(irq, !!(state & 1));
          state >>= 1;
        }
        return;
      }
      case 0xbe1:
        return; // MEIPA
      case 0xbe2: {
        // MEIFA
        let state = value >>> 16;
        for (let irq = (raw_write & 0b11111) * 16; irq < (raw_write & 0b11111) * 16 + 16; irq++) {
          const forced = state & 1;
          this.meifa[irq] = forced;
          if (forced) this.setInterrupt(irq, true);
          else if (irq >= 46) this.setInterrupt(irq, false);
          state >>= 1;
        }
        return;
      }
      case 0xbe3: {
        // MEIPRA
        let state = value >>> 16;
        for (let irq = (raw_write & 0b11111) * 4; irq < (raw_write & 0b11111) * 4 + 4; irq++) {
          this.meipra[irq] = state & 0b1111;
          if (this.meipa[irq]) {
            this.setInterrupt(irq, false);
            this.setInterrupt(irq, true);
          }
          state >>= 4;
        }
        return;
      }
      case 0xbe4: {
        // MEINEXT
        if (value & 1) {
          // MEINEXT.UPDATE set
          this.updateMEICONTEXT_update();
          this.updateMEINEXT();
          this.interruptsUpdated = true;
        }
        return;
      }
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
      case 0xf11:
      case 0xf12:
      case 0xf13:
      case 0xf14:
        return;
    }
    this.logger.info(
      this.coreLabel,
      `Unknown CSR set: 0x${value.toString(16)} => 0x${csr.toString(16)}`
    );
    this.csrs[csr] = value;
  }

  // Packs `count` consecutive elements from `base` into one word, MSB-first from
  // the END — i.e. `arr.slice(base, base+count).reduceRight((a,v) => (a<<bits)|v, 0)`,
  // but without `.slice()`/`.reduceRight()` (unsupported by the C transpile).
  private packReverse(arr: number[], base: number, count: number, bits: number): number {
    let acc = 0;
    for (let i = count - 1; i >= 0; i--) {
      acc = (acc << bits) | arr[base + i];
    }
    return acc;
  }

  getCSR(csr: number, raw_write: number): number {
    raw_write >>>= 0;
    // raw_write: instruction raw write value, used for Xh3irq interrupt array indices
    // MSLEEP 0xbf0
    switch (csr) {
      case 0xf14:
        return this.mhartid;
      case 0x300: // MSTATUS
      case 0x301:
      case 0x302:
      case 0x303:
      case 0x304: // MIE
      case 0x305: // MTVEC
      case 0x340: // MSCRATCH
      case 0x341:
      case 0x342:
      case 0x343:
      case 0x344:
      case 0xbf0:
        return this.csrs[csr];
      case 0xbe0:
        return (this.packReverse(this.meiea, (raw_write & 0b11111) * 16, 16, 1) << 16) >>> 0;
      case 0xbe1:
        return (this.packReverse(this.meipa, (raw_write & 0b11111) * 16, 16, 1) << 16) >>> 0;
      case 0xbe2:
        return (this.packReverse(this.meifa, (raw_write & 0b11111) * 16, 16, 1) << 16) >>> 0;
      case 0xbe3:
        return (this.packReverse(this.meipra, (raw_write & 0b11111) * 4, 4, 4) << 16) >>> 0;
      case 0xbe4: {
        const meinext = this.csrs[csr] >>> 0;
        if (!(meinext >> 31)) {
          // reading MEINEXT clears MEIFA bits
          const irq = (meinext >> 2) & 511;
          const old_forced = this.meifa[irq];
          this.meifa[irq] = 0;
          if (irq >= 46 && old_forced) this.setInterrupt(irq, false); // for soft irqs, removing MEIFA will deassert the irq
          //TODO deassert lower irqs as well?
        }
        return meinext;
      }
      case 0xbe5: {
        let meicontext = this.csrs[0xbe5];
        if (raw_write & 0b0010) {
          // write to CLEARTS
          meicontext &= ~0b1110;
          meicontext |= ((this.csrs[0x304] >>> 7) & 1) << 3; // MTIE
          meicontext |= ((this.csrs[0x304] >>> 3) & 1) << 2; // MSIE
          this.csrs[0x304] &= ~0b10001000; // clear MIE.MTIE and MSIE
        } else {
          if (raw_write & 0b1000) this.csrs[0x304] |= 1 << 7; // write to MTIESAVE: set MIE.MTIE
          if (raw_write & 0b0100) this.csrs[0x304] |= 1 << 3; // write to MSIESAVE: set MIE.MSIE
        }
        return meicontext;
      }
    }
    this.logger.info(this.coreLabel, `Unknown CSR get: 0x${csr.toString(16)}`);
    return this.csrs[csr];
  }
}

// High 32 bits of the product of two UNSIGNED 32-bit values, computed via
// 16-bit partial products so no intermediate exceeds 2^53 (float-exact).
function umulh(a: number, b: number): number {
  // Typed as Uint32 to avoid C signed overflow: int32_t multiplication past 2.147B
  // is undefined behavior, but these products can reach ~4.29B.
  const aL: Uint32 = a & 0xffff,
    aH: Uint32 = a >>> 16,
    bL: Uint32 = b & 0xffff,
    bH: Uint32 = b >>> 16;
  const ll = aL * bL;
  const lh = aL * bH;
  const hl = aH * bL;
  const hh = aH * bH;
  const cross = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (hh + (lh >>> 16) + (hl >>> 16) + (cross >>> 16)) >>> 0;
}

function signExtend8(value: number) {
  return (value << 24) >> 24;
}

function signExtend16(value: number) {
  return (value << 16) >> 16;
}

// Profiler trace magic: a 0xabcd/0xffff marker at magicStart signals that a
// NUL-terminated trace-tag string follows; onTrace consumes it. Called from the
// JAL/JALR execution arms (link address = pc + inst_length), so both 32-bit and
// compressed (C.J/C.JAL) jumps fire traces — the compressed forms decode to the
// same T_JAL/T_JALR with inst_length=2.
export function checkTraceMagic(cpu: CPU, magicStart: number) {
  if (
    cpu.chip.readUint16(magicStart) === 0xabcd &&
    cpu.chip.readUint16(magicStart + 2) === 0xffff
  ) {
    let profTag = '';
    for (let i = magicStart + 4; ; i++) {
      const ch = cpu.chip.readUint8(i);
      if (ch === 0) break;
      profTag += String.fromCharCode(ch);
    }
    cpu.chip.onTrace(cpu.mhartid, cpu.pc, profTag);
  }
}
