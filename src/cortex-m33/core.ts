import { ICpuCore } from '../cpu-core';
import type { RP2350 } from '../rp2350';
import { M33Registers } from './registers';
import { conditionPassed } from './conditions';
import { executeThumb16, advanceItState } from './execute-thumb16';
import { executeThumb32, isThumb32, ImmCarry, Mul64Result } from './execute-thumb32';
import type { M33CoreState } from '../peripherals/ppb_rp2350';
import { FpResult } from './fpu-helpers';
import { Int53 } from '../utils/types';

/** Exception numbers per ARMv8-M. */
export const EXC_RESET = 1;
export const EXC_NMI = 2;
export const EXC_HARDFAULT = 3;
export const EXC_MEMMANAGE = 4;
export const EXC_BUSFAULT = 5;
export const EXC_USAGEFAULT = 6;
export const EXC_SECUREFAULT = 7;
export const EXC_SVCALL = 11;
export const EXC_DEBUGMON = 12;
export const EXC_PENDSV = 14;
export const EXC_SYSTICK = 15;
/** First external IRQ vector number. */
export const EXC_EXTERNAL = 16;

const CONTROL_FPCA = 1 << 2;
const FPCCR_LSPEN = 1 << 30;
const FPCCR_LSPACT = 1 << 0;
const UFSR_STKOF = 1 << 20;
const HFSR_FORCED = 1 << 30;
const SHCSR_MEMFAULTENA = 1 << 16;
const SHCSR_BUSFAULTENA = 1 << 17;
const SHCSR_USGFAULTENA = 1 << 18;

export enum Fault {
  UsageFault,
  MemManage,
  BusFault,
  Nmi,
}

enum ExecutionModeM33 {
  Thread,
  Handler,
}

/**
 * Cortex-M33 CPU core (ARMv8-M Mainline + Security + FPU + DSP).
 * See RP2350 datasheet §3.7.
 */
export class CortexM33Core implements ICpuCore {
  readonly regs = new M33Registers();
  /** Monotonically increasing per-core cycle count. */
  cycles: Int53 = 0; // avoids int32_t overflow past ~2.15B cycles

  getCycles(): Int53 {
    return this.cycles;
  }

  addCycles(delta: number) {
    this.cycles += delta;
  }

  /** True while parked in WFI. */
  waiting = false;
  /** True when a WFE event has been latched but not yet consumed. */
  eventRegistered = false;
  /** Set when IRQ pending state changes; cleared by checkForInterrupts(). */
  interruptsUpdated = false;
  /** How many bytes to rewind the last break instruction (BKPT/UDF). */
  breakRewind = 0;
  /** Address of the instruction currently being executed (for sync-fault return). */
  currentInstrAddr = 0;

  // System exception pending flags.
  pendingSVCall = false;
  pendingFault: Fault | null = null;

  /** Current execution mode (Thread vs Handler). */
  currentMode: ExecutionModeM33 = ExecutionModeM33.Thread;
  /** Security state: true=Secure, false=Non-secure. Reset defaults to Secure. */
  secure = true;

  /** Sibling core for SEV (send-event) inter-core wakeup. Set by the chip.
   * Stored concretely (not as ICpuCore) — see setOtherCore's own comment. */
  otherCore!: CortexM33Core;

  // The param stays ICpuCore-typed (callers only see the interface), but the field is
  // stored concretely: fireSEV() reads/writes `otherCore.waiting`/`.eventRegistered`
  // as plain property access, which cts2c silently stubs to no-ops through an
  // interface-typed value (see cpu-core.ts).
  setOtherCore(other: ICpuCore) {
    this.otherCore = other as unknown as CortexM33Core;
  }

  /** Hook fired on BKPT / UDF trap. */
  onBreak?: (code: number) => void;

  /** Hook fired on BL / BLX (profiler / trace). */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  blTaken = (_core: CortexM33Core, _blx: boolean) => {};

  /**
   * Reusable out-parameter scratch for fpu-helpers.ts's f32 ops (see FpResult) —
   * owned here because fpuExecute is a free function with no instance of its own.
   */
  readonly fpResultScratch: FpResult;

  /** Reusable out-parameter scratch for execute-thumb32.ts's thumbExpandImm/
   * thumbExpandImmC (see ImmCarry's own comment) — same reasoning/pattern as
   * fpResultScratch above. */
  readonly immCarryScratch: ImmCarry;

  /** Reusable out-parameter scratch for execute-thumb32.ts's mul64/mul64Signed (see
   * Mul64Result's own comment) — same reasoning/pattern as fpResultScratch above. */
  readonly mul64Scratch: Mul64Result;

  constructor(readonly chip: RP2350, readonly coreLabel: string, readonly coreIndex: number) {
    this.regs.reset();
    this.fpResultScratch = { value: 0, fpscr: 0 };
    this.immCarryScratch = { value: 0, carryOut: false };
    this.mul64Scratch = { hi: 0, lo: 0 };
  }

  get logger() {
    return this.chip.logger;
  }

  get PC(): number {
    return this.regs.pc;
  }
  set PC(value: number) {
    this.regs.pc = value;
  }

  /** Fetch the per-core PPB state if the chip is ARM. */
  ppb(): M33CoreState {
    const chip = this.chip as unknown as {
      ppb?: { coreState: [M33CoreState, M33CoreState] };
    };
    return chip.ppb!.coreState[this.coreIndex];
  }

  // SEV (send-event): wake the sibling core if it's sleeping, otherwise latch
  // a pending event so its next WFE returns immediately.
  fireSEV() {
    if (this.otherCore.waiting) {
      this.otherCore.waiting = false;
    } else {
      this.otherCore.eventRegistered = true;
    }
  }

  /**
   * Reset the core to its post-boot state.
   *
   * @param enableCoprocessors When true, sets CPACR to enable full access to
   * all 8 coprocessor slots (CP0-CP11) directly. See `RP2350.reset()`.
   */
  reset(enableCoprocessors = false) {
    this.regs.reset();
    this.cycles = 0;
    this.waiting = false;
    this.eventRegistered = false;
    this.interruptsUpdated = false;
    this.pendingSVCall = false;
    this.pendingFault = null;
    this.currentMode = ExecutionModeM33.Thread;
    this.secure = true;

    if (enableCoprocessors) {
      this.ppb().cpacr = 0x00ffcf03;
    }

    // ARMv8-M hardware reset: load initial MSP from [VTOR+0] and the reset
    // vector from [VTOR+4] (bit0 forced to 1 in the vector table to select
    // Thumb state; masked off here since regs.pc always holds a plain
    // word-aligned address).
    const vtor = this.ppb().vtor >>> 0;
    const initialSp = this.chip.readUint32(vtor) >>> 0;
    this.regs.msp = initialSp;
    this.regs.sp = initialSp;
    this.regs.pc = (this.chip.readUint32(vtor + 4) >>> 0) & ~1;
  }

  /**
   * Assert / deassert a hardware interrupt. Routes into the per-core NVIC
   * pending bit array (held on the PPB peripheral so it's reachable from
   * MMIO writes too).
   */
  setInterrupt(irq: number, value: boolean) {
    if (irq < 0 || irq >= 52) return;
    const st = this.ppb();
    const bank = irq < 32 ? 0 : 1;
    const bit = irq < 32 ? irq : irq - 32;
    const mask = 1 << bit;
    if (value) {
      if (!(st.nvicPending[bank] & mask)) {
        st.nvicPending[bank] |= mask;
        this.interruptsUpdated = true;
        if (this.waiting && this.checkForInterrupts()) {
          this.waiting = false;
        }
      }
    } else {
      st.nvicPending[bank] &= ~mask;
    }
  }

  /**
   * Find the highest-priority pending exception that beats the current
   * execution priority, and enter its handler. Implements PRIMASK / FAULTMASK
   * / BASEPRI masking + 16-level priority arbitration.
   *
   * Returns true if a handler was entered.
   */
  checkForInterrupts(): boolean {
    const regs = this.regs;
    const st = this.ppb();

    // Compute current execution priority.
    let currentPriority = regs.ipsr === 0 ? 0x100 : this.exceptionPriority(regs.ipsr);
    if (regs.primask) currentPriority = Math.min(currentPriority, 0);
    if (regs.faultmask) currentPriority = Math.min(currentPriority, -1);
    if (regs.basepri) currentPriority = Math.min(currentPriority, regs.basepri & 0xe0);

    if (st.pendingNMI && this.exceptionPriority(EXC_NMI) < currentPriority) {
      st.pendingNMI = false;
      this.exceptionEntry(EXC_NMI);
      return true;
    }
    if (this.pendingSVCall && this.exceptionPriority(EXC_SVCALL) < currentPriority) {
      this.pendingSVCall = false;
      this.exceptionEntry(EXC_SVCALL);
      return true;
    }
    if (st.pendingPendSV && this.exceptionPriority(EXC_PENDSV) < currentPriority) {
      st.pendingPendSV = false;
      this.exceptionEntry(EXC_PENDSV);
      return true;
    }
    if (st.pendingSystick && this.exceptionPriority(EXC_SYSTICK) < currentPriority) {
      st.pendingSystick = false;
      this.exceptionEntry(EXC_SYSTICK);
      return true;
    }

    // External IRQs: highest-priority (lowest number) wins. Priorities are
    // stored as the top nibble (4-bit); convert to the unified &0xE0 byte
    // scale used by exceptionPriority / BASEPRI / system exceptions.
    let bestVector = -1;
    let bestPriority = currentPriority;
    for (let irq = 0; irq < 52; irq++) {
      const bank = irq < 32 ? 0 : 1;
      const bit = irq < 32 ? irq : irq - 32;
      if ((st.nvicPending[bank] & (1 << bit)) !== 0 && (st.nvicEnabled[bank] & (1 << bit)) !== 0) {
        const pri = (st.nvicPriority[irq] << 4) & 0xe0;
        if (pri < bestPriority) {
          bestPriority = pri;
          bestVector = EXC_EXTERNAL + irq;
        }
      }
    }
    if (bestVector >= 0) {
      const irq = bestVector - EXC_EXTERNAL;
      const bank = irq < 32 ? 0 : 1;
      const bit = irq < 32 ? irq : irq - 32;
      st.nvicPending[bank] &= ~(1 << bit);
      st.nvicActive[bank] |= 1 << bit;
      this.exceptionEntry(bestVector);
      return true;
    }

    this.interruptsUpdated = false;
    return false;
  }

  /** Compute the priority of a given exception vector. */
  private exceptionPriority(excNum: number): number {
    const st = this.ppb();
    switch (excNum) {
      case EXC_RESET:
        return -3;
      case EXC_NMI:
        return -2;
      case EXC_HARDFAULT:
        return -1;
      case EXC_SVCALL:
        // SVCall priority is SHPR2 byte 0 (bits [31:24]). Unified &0xE0 scale.
        return (st.shpr2 >>> 24) & 0xe0;
      case EXC_PENDSV:
        // PendSV priority is SHPR3 byte 1 (bits [23:16]).
        return (st.shpr3 >>> 16) & 0xe0;
      case EXC_SYSTICK:
        // SysTick priority is SHPR3 byte 0 (bits [31:24]).
        return (st.shpr3 >>> 24) & 0xe0;
      default:
        if (excNum >= EXC_EXTERNAL) {
          // External IRQ priorities are stored as the top nibble (4-bit) of the
          // byte; shift to full-byte and mask to the unified &0xE0 scale.
          return (st.nvicPriority[excNum - EXC_EXTERNAL] << 4) & 0xe0;
        }
        return 0x100; // unused / reserved
    }
  }

  /** Exception entry with FP stacking, stack-limit check, lockup detection. */
  exceptionEntry(excNum: number) {
    const regs = this.regs;
    const st = this.ppb();

    // Lockup: HardFault-in-HardFault. Real hardware enters a "stable fault"
    // state and stops fetching; we just return without taking the exception.
    if (excNum === EXC_HARDFAULT && regs.ipsr === EXC_HARDFAULT) {
      return;
    }

    regs.syncSpToBanked();
    const usePsp = !regs.inHandlerMode() && regs.activeSpIsPsp();
    const originalSp = usePsp ? regs.psp : regs.msp;
    const alignedSp = originalSp & ~0x7;
    const wasPadded = alignedSp !== originalSp;

    const hadFp = (regs.control & CONTROL_FPCA) !== 0;
    const fpExtra = hadFp ? 72 : 0;
    const frameSp = (alignedSp - 0x20 - fpExtra) >>> 0;

    // Stack-limit check.
    const limit = usePsp ? regs.psplim : regs.msplim;
    if (limit > 0 && frameSp < limit) {
      st.cfsr |= UFSR_STKOF;
      regs.control &= ~0x2;
      regs.syncSpFromBanked();
      this.pendingFault = Fault.UsageFault;
      return;
    }

    // Stacked xPSR.
    const itMask = 0x0600fc00;
    const itBits = ((regs.itState & 0xc0) << 19) | ((regs.itState & 0x3f) << 10);
    let stackedXpsr = (regs.xpsr & ~itMask) | itBits;
    if (wasPadded) stackedXpsr |= 1 << 9;

    // Push basic frame.
    this.chip.writeUint32(frameSp, regs.r[0]);
    this.chip.writeUint32((frameSp + 4) >>> 0, regs.r[1]);
    this.chip.writeUint32((frameSp + 8) >>> 0, regs.r[2]);
    this.chip.writeUint32((frameSp + 12) >>> 0, regs.r[3]);
    this.chip.writeUint32((frameSp + 16) >>> 0, regs.r[12]);
    this.chip.writeUint32((frameSp + 20) >>> 0, regs.lr);
    // Return address: synchronous faults (3-7) retry the faulting instruction
    // (currentInstrAddr); async exceptions (SVC, PendSV, SysTick, IRQs) return
    // to the next instruction (regs.pc).
    const returnAddr =
      excNum >= EXC_HARDFAULT && excNum <= EXC_SECUREFAULT ? this.currentInstrAddr >>> 0 : regs.pc;
    this.chip.writeUint32((frameSp + 24) >>> 0, returnAddr & ~1);
    this.chip.writeUint32((frameSp + 28) >>> 0, stackedXpsr >>> 0);

    // FP context.
    if (hadFp) {
      const fpRegionSp = (frameSp + 0x20) >>> 0;
      st.fpcar = fpRegionSp;
      if (st.fpccr & FPCCR_LSPEN) {
        st.fpccr |= FPCCR_LSPACT;
      } else {
        for (let i = 0; i < 16; i++) {
          this.chip.writeUint32((fpRegionSp + i * 4) >>> 0, regs.s[i] >>> 0);
        }
        this.chip.writeUint32((fpRegionSp + 64) >>> 0, regs.fpscr);
        this.chip.writeUint32((fpRegionSp + 68) >>> 0, 0);
      }
    }

    if (usePsp) regs.psp = frameSp;
    else regs.msp = frameSp;

    // EXC_RETURN: FType[4]=0 when FP frame present.
    let excReturn = hadFp ? 0xffffffe0 : 0xfffffff0;
    if (regs.inHandlerMode()) excReturn |= 0x1;
    else if (usePsp) excReturn |= 0xd;
    else excReturn |= 0x9;
    regs.lr = excReturn >>> 0;

    const vector = this.chip.readUint32((st.vtor + excNum * 4) >>> 0) >>> 0;
    regs.pc = (vector & ~1) >>> 0;

    regs.xpsr = ((regs.xpsr & ~0x1ff) | excNum) >>> 0;
    regs.control &= ~0x2;
    regs.control &= ~CONTROL_FPCA;
    regs.itState = 0;
    regs.syncSpFromBanked();
    this.currentMode = ExecutionModeM33.Handler;
    this.eventRegistered = true;
  }

  /** Exception return: pop frame, FP unstacking, integrity check, tail-chain. */
  exceptionReturn(excReturn: number) {
    const regs = this.regs;
    const st = this.ppb();
    const returnToPsp = (excReturn & 0x4) !== 0;
    const returnToHandler = (excReturn & 0x8) === 0;
    const hadFpFrame = (excReturn & 0x10) === 0;

    // Integrity check: FType must match lazy-FP state.
    const lspact = (st.fpccr & FPCCR_LSPACT) !== 0;
    if (hadFpFrame ? !lspact && st.fpcar === 0 : lspact) {
      st.cfsr |= 1 << 17; // INVPC
      this.pendingFault = Fault.UsageFault;
      return;
    }

    regs.syncSpToBanked();
    const frameSp = returnToPsp ? regs.psp : regs.msp;

    // Pop basic frame.
    regs.r[0] = this.chip.readUint32(frameSp) >>> 0;
    regs.r[1] = this.chip.readUint32((frameSp + 4) >>> 0) >>> 0;
    regs.r[2] = this.chip.readUint32((frameSp + 8) >>> 0) >>> 0;
    regs.r[3] = this.chip.readUint32((frameSp + 12) >>> 0) >>> 0;
    regs.r[12] = this.chip.readUint32((frameSp + 16) >>> 0) >>> 0;
    regs.lr = this.chip.readUint32((frameSp + 20) >>> 0) >>> 0;
    const newPc = this.chip.readUint32((frameSp + 24) >>> 0) >>> 0;
    const psr = this.chip.readUint32((frameSp + 28) >>> 0) >>> 0;

    // Lazy FP flush + pop. The FP region lives at frameSp + 0x20 (above the
    // basic frame), computed from the local popping SP — NOT from the global
    // st.fpcar, which is overwritten by each FP-frame entry and would be wrong
    // for nested FP exceptions.
    if (hadFpFrame && lspact) this.flushLazyFp();
    if (hadFpFrame) {
      const fpRegionSp = (frameSp + 0x20) >>> 0;
      for (let i = 0; i < 16; i++) {
        regs.s[i] = this.chip.readUint32((fpRegionSp + i * 4) >>> 0);
      }
      regs.fpscr = this.chip.readUint32((fpRegionSp + 64) >>> 0) >>> 0;
    }

    const padBit = (psr & (1 << 9)) !== 0 ? 4 : 0;
    const frameSize = 0x20 + (hadFpFrame ? 72 : 0) + padBit;
    const newSp = (frameSp + frameSize) >>> 0;
    if (returnToPsp) regs.psp = newSp;
    else regs.msp = newSp;

    // Restore xPSR: force T-bit (always Thumb), strip alignment pad (bit 9)
    // and IT bits [26:25,15:10] (IT state lives in the separate itState field).
    const IT_MASK = 0x0600fc00;
    regs.xpsr = ((psr | 0x01000000) & ~(1 << 9) & ~IT_MASK) >>> 0;
    // Decode IT state from the stacked xPSR: bits [26:25] ← IT[7:6], [15:10] ← IT[5:0].
    regs.itState = (((psr >>> 19) & 0xc0) | ((psr >>> 10) & 0x3f)) & 0xff;
    regs.pc = (newPc & ~1) >>> 0;

    if (returnToHandler) {
      this.currentMode = ExecutionModeM33.Handler;
      regs.control &= ~0x2;
    } else {
      this.currentMode = ExecutionModeM33.Thread;
      if (returnToPsp) regs.control |= 0x2;
      else regs.control &= ~0x2;
    }
    regs.syncSpFromBanked();

    const wasActiveVector = regs.ipsr;
    if (wasActiveVector >= EXC_EXTERNAL) {
      const irq = wasActiveVector - EXC_EXTERNAL;
      const bank = irq < 32 ? 0 : 1;
      const bit = irq < 32 ? irq : irq - 32;
      st.nvicActive[bank] &= ~(1 << bit);
    }
    if (!returnToHandler) {
      regs.xpsr = (regs.xpsr & ~0x1ff) >>> 0;
    }
    // CONTROL.FPCA = NOT EXC_RETURN[4] = hadFpFrame, in ALL cases (both Thread
    // and Handler return). FPCA=1 iff an FP frame was stacked on entry.
    if (hadFpFrame) {
      regs.control |= CONTROL_FPCA;
    } else {
      regs.control &= ~CONTROL_FPCA;
    }
    this.interruptsUpdated = true;
    this.eventRegistered = true;
  }

  /** Flush lazy FP state to the reserved frame. */
  flushLazyFp() {
    const regs = this.regs;
    const st = this.ppb();
    if (!(st.fpccr & FPCCR_LSPACT)) return;
    const fpRegionSp = st.fpcar;
    for (let i = 0; i < 16; i++) {
      this.chip.writeUint32((fpRegionSp + i * 4) >>> 0, regs.s[i] >>> 0);
    }
    this.chip.writeUint32((fpRegionSp + 64) >>> 0, regs.fpscr);
    st.fpccr &= ~FPCCR_LSPACT;
    regs.control |= CONTROL_FPCA;
  }

  /** Deliver a synchronous fault, escalating to HardFault if handler disabled. */
  deliverFault(fault: Fault) {
    const st = this.ppb();
    let excNum: number;
    switch (fault) {
      case Fault.UsageFault:
        excNum =
          st.shcsr & SHCSR_USGFAULTENA ? EXC_USAGEFAULT : ((st.hfsr |= HFSR_FORCED), EXC_HARDFAULT);
        break;
      case Fault.MemManage:
        excNum =
          st.shcsr & SHCSR_MEMFAULTENA ? EXC_MEMMANAGE : ((st.hfsr |= HFSR_FORCED), EXC_HARDFAULT);
        break;
      case Fault.BusFault:
        excNum =
          st.shcsr & SHCSR_BUSFAULTENA ? EXC_BUSFAULT : ((st.hfsr |= HFSR_FORCED), EXC_HARDFAULT);
        break;
      case Fault.Nmi:
        excNum = EXC_NMI;
        break;
    }
    this.exceptionEntry(excNum);
  }

  /**
   * BX/POP-PC write to PC: detect EXC_RETURN magic and trigger exception
   * return when in Handler mode. Per ARMv8-M §B1.5.2, EXC_RETURN bits
   * [31:24]=0xff.
   */
  bxWritePC(address: number) {
    if (this.regs.inHandlerMode() && address >>> 24 === 0xff) {
      this.exceptionReturn(address & 0x0fffffff);
    } else {
      this.regs.pc = (address & ~1) >>> 0;
    }
  }

  /**
   * Byte-composed unaligned memory access helpers. Only LDR/STR (single
   * register), LDRH/STRH, and TBH may access unaligned addresses in Normal
   * memory (ARMv8-M ARM §B8.3 / RP2350 datasheet) — LDM/STM, LDRD/STRD, and
   * the exclusive/acquire-release family require natural alignment and fault
   * otherwise (`this.chip.readUint32`/`writeUint32`/`readUint16`/
   * `writeUint16` throw on misalignment; callers executing those opcodes
   * must keep calling them directly instead of these helpers).
   */
  readUint32Unaligned(address: number): number {
    address = address >>> 0;
    if ((address & 0x3) === 0) return this.chip.readUint32(address) >>> 0;
    return (
      (this.chip.readUint8(address) |
        (this.chip.readUint8((address + 1) >>> 0) << 8) |
        (this.chip.readUint8((address + 2) >>> 0) << 16) |
        (this.chip.readUint8((address + 3) >>> 0) << 24)) >>>
      0
    );
  }

  writeUint32Unaligned(address: number, value: number): void {
    address = address >>> 0;
    if ((address & 0x3) === 0) {
      this.chip.writeUint32(address, value);
      return;
    }
    this.chip.writeUint8(address, value & 0xff);
    this.chip.writeUint8((address + 1) >>> 0, (value >>> 8) & 0xff);
    this.chip.writeUint8((address + 2) >>> 0, (value >>> 16) & 0xff);
    this.chip.writeUint8((address + 3) >>> 0, (value >>> 24) & 0xff);
  }

  readUint16Unaligned(address: number): number {
    address = address >>> 0;
    if ((address & 0x1) === 0) return this.chip.readUint16(address) >>> 0;
    return (this.chip.readUint8(address) | (this.chip.readUint8((address + 1) >>> 0) << 8)) >>> 0;
  }

  writeUint16Unaligned(address: number, value: number): void {
    address = address >>> 0;
    if ((address & 0x1) === 0) {
      this.chip.writeUint16(address, value);
      return;
    }
    this.chip.writeUint8(address, value & 0xff);
    this.chip.writeUint8((address + 1) >>> 0, (value >>> 8) & 0xff);
  }

  executeInstructionsUpTo(cycle: Int53) {
    // Parked in WFI/WFE: executeInstruction() would just tick `cycles` by one per
    // call, and nothing in this window can wake us — the other core isn't executing,
    // and peripherals/the clock only advance after the caller's catch-up loop
    // returns. So landing on `cycle` directly is exactly what the loop would have
    // produced, in O(1) instead of O(cycle - cycles). This is the common case for a
    // core whose firmware never launched it.
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

  /**
   * Execute one instruction: Thumb-16 / Thumb-32 dispatch, IT-block handling,
   * and exception entry on pending IRQs.
   */
  executeInstruction(): number {
    if (this.waiting) {
      this.cycles++;
      return 1;
    }
    if (this.interruptsUpdated) {
      if (this.checkForInterrupts()) {
        if (this.pendingFault !== null) {
          const f = this.pendingFault;
          this.pendingFault = null;
          this.deliverFault(f);
        }
        this.cycles += 12;
        return 12;
      }
    }

    const regs = this.regs;
    const opcodePC = regs.pc & ~1;
    this.currentInstrAddr = opcodePC;
    const opcode = this.chip.readUint16(opcodePC);

    // Detect 32-bit Thumb instruction (prefix 0b11101 / 0b11110 / 0b11111
    // in bits [15:11] per ARMv7-M §A5.1). Fetch the second halfword upfront.
    const wide = isThumb32(opcode);
    const opcode2 = wide ? this.chip.readUint16(opcodePC + 2) : 0;

    // IT-block evaluation: if we're inside an IT block, gate execution on
    // the current instruction's cond.
    const inItBlock = regs.itState !== 0;
    let pass = true;
    if (inItBlock) {
      // ITSTATE[7:4] already holds the effective condition for this instruction
      // (advanceItState shifts the then/else bit into cond[0] each step), so no
      // manual inversion is needed here.
      pass = conditionPassed(regs, (regs.itState >>> 4) & 0xf);
    }

    // Rebase on `opcodePC` (already masked even), not raw `regs.pc` — a
    // stray bit0 (e.g. from a data-processing write to Rd=15 bypassing
    // bxWritePC's masking) would otherwise propagate into every later
    // PC-as-operand use (TBB/TBH, ADR, etc.) until the next real branch.
    regs.pc = (opcodePC + 2) >>> 0;
    if (wide) {
      regs.pc = (opcodePC + 4) >>> 0;
    }

    let deltaCycles: number;
    if (pass) {
      if (wide) {
        // Thumb-32 dispatch.
        const result = executeThumb32(this, opcodePC, opcode, opcode2);
        deltaCycles = result < 0 ? 1 : result;
        if (result < 0) {
          // An unimplemented opcode is almost certainly an emulator bug.
          // Skip the throw when a fault is already pending (e.g. NOCP from a
          // disabled CP10/11): the fault path below is gated on `!stopped`.
          if (this.pendingFault === null) {
            throw new Error(
              `Unimplemented Thumb-32 instruction at 0x${opcodePC.toString(
                16
              )} (0x${opcode.toString(16)} 0x${opcode2.toString(16)})`
            );
          }
        }
      } else {
        const result = executeThumb16(this, opcodePC, opcode);
        if (result === -1) {
          // Should have been caught by isThumb32 — treat as unimplemented.
          if (this.pendingFault === null) {
            throw new Error(
              `Unimplemented Thumb-16 instruction at 0x${opcodePC.toString(
                16
              )} (0x${opcode.toString(16)})`
            );
          }
          deltaCycles = 1;
        } else {
          deltaCycles = result;
        }
      }
    } else {
      // IT-block condition failed: skip.
      deltaCycles = 1;
    }

    if (inItBlock) {
      advanceItState(this);
    }

    // Deliver pending synchronous fault.
    if (this.pendingFault !== null) {
      const f = this.pendingFault;
      this.pendingFault = null;
      this.deliverFault(f);
      this.cycles += 12;
      return 12 + deltaCycles;
    }

    this.cycles += deltaCycles;
    return deltaCycles;
  }
}
