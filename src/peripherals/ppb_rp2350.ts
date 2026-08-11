/**
 * Private Peripheral Bus (PPB) for the RP2350 Cortex-M33 cores.
 *
 * The PPB region (0xE0000000 – 0xE00FFFFF) is per-core on the M33: each core
 * has its own NVIC, SCB, SysTick, MPU, SAU, FPU control, and debug registers.
 * This peripheral owns two per-core copies of that state and dispatches via
 * `readUint32ViaCore` / `writeUint32ViaCore` (same convention as the RP2040's
 * `peripherals/ppb.ts`).
 *
 * Implements: CPUID read (M33 r0p1, per datasheet §3.7.5), NVIC ISER/ICER/ISPR/
 * ICPR (52 external IRQs → 2 banks), ICSR, VTOR (secure alias), SysTick CSR/RVR/
 * CVR/CALIB (per core), SHPR1/2/3, SHCSR, CFSR, HFSR, CPACR, AIRCR, SCR, CCR,
 * priority arbitration, the 16-level priority model, and MPU/SAU/FP/DWT
 * registers.
 *
 * Reference: RP2350 datasheet §3.7.5; ARMv8-M Architecture Reference Manual.
 */

import { AlarmCallback } from '../clock/clock';
import { CortexM33Core } from '../cortex-m33/core';
import { IRPChip } from '../rpchip';
// Type-only: RPPPB2350 is only ever constructed by RP2350 (see rp2350.ts) — a
// type-only import doesn't create a real circular dependency (it's erased entirely
// at compile time), so this is safe despite rp2350.ts importing this file too.
import type { RP2350 } from '../rp2350';
import { Timer32, Timer32PeriodicAlarm, TimerMode } from '../utils/timer32';
import { BasePeripheral } from './peripheral';
import { SimulationClock } from '../clock/simulation-clock';

// SCS (System Control Space) offsets within PPB.
// Offsets are address bits [23:0] (mask 0xffffff) — i.e. the full offset
// from 0xe0000000, NOT the 12-bit-only offset used by the RP2040 PPB.
// This keeps DWT (0xe0001000) from aliasing with NVIC (0xe000e100).
const NVIC_BASE = 0x000e100;
const SYSTICK_BASE = 0x000e010;
const SCB_BASE = 0x000ed00;

// SCB register offsets.
export const SCB_CPUID = 0xed00;
export const SCB_ICSR = 0xed04;
export const SCB_VTOR = 0xed08;
export const SCB_AIRCR = 0xed0c;
export const SCB_SCR = 0xed10;
export const SCB_CCR = 0xed14;
export const SCB_SHPR1 = 0xed18;
export const SCB_SHPR2 = 0xed1c;
export const SCB_SHPR3 = 0xed20;
export const SCB_SHCSR = 0xed24;
export const SCB_CFSR = 0xed28;
export const SCB_HFSR = 0xed2c;
export const SCB_DFSR = 0xed30;
export const SCB_MMFAR = 0xed34;
export const SCB_BFAR = 0xed38;
export const SCB_CPACR = 0xed88;
export const SCB_NSACR = 0xed8c;

// MPU register offsets.
export const MPU_TYPE = 0xed90;
export const MPU_CTRL = 0xed94;
export const MPU_RNR = 0xed98;
export const MPU_RBAR = 0xed9c;
export const MPU_RLAR = 0xeda0;
export const MPU_MAIR0 = 0xedc0;
export const MPU_MAIR1 = 0xedc4;

// SAU register offsets.
export const SAU_CTRL = 0xedd0;
export const SAU_TYPE = 0xedd4;
export const SAU_RNR = 0xedd8;
export const SAU_RBAR = 0xeddc;
export const SAU_RLAR = 0xede0;
export const SCB_SFSR = 0xede4;
export const SCB_SFAR = 0xede8;

// Floating-point register offsets.
export const SCB_FPCCR = 0xef34;
export const SCB_FPCAR = 0xef38;
export const SCB_FPDSCR = 0xef3c;
export const SCB_MVFR0 = 0xef40;
export const SCB_MVFR1 = 0xef44;
export const SCB_MVFR2 = 0xef48;

// SysTick offsets (relative to SYSTICK_BASE).
const SYST_CSR = 0x010;
const SYST_RVR = 0x014;
const SYST_CVR = 0x018;
const SYST_CALIB = 0x01c;

// NVIC register offsets (relative to NVIC_BASE).
const NVIC_ISER0 = 0x000;
const NVIC_ISER1 = 0x004;
const NVIC_ICER0 = 0x080;
const NVIC_ICER1 = 0x084;
const NVIC_ISPR0 = 0x100;
const NVIC_ISPR1 = 0x104;
const NVIC_ICPR0 = 0x180;
const NVIC_ICPR1 = 0x184;
const NVIC_IABR0 = 0x200;
const NVIC_IABR1 = 0x204;
const NVIC_IPR0 = 0x400;
const NVIC_IPR_LAST = 0x43f; // 16 priority registers × 4 bytes

// ICSR bits.
const ICSR_NMIPENDSET = 1 << 31;
const ICSR_PENDSVSET = 1 << 28;
const ICSR_PENDSVCLR = 1 << 27;
const ICSR_PENDSTSET = 1 << 26;
const ICSR_PENDSTCLR = 1 << 25;
const ICSR_ISRPREEMPT = 1 << 23;
const ICSR_ISRPENDING = 1 << 22;
const ICSR_VECTPENDING_SHIFT = 12;
const ICSR_VECTPENDING_MASK = 0x1ff;
const ICSR_VECTACTIVE_SHIFT = 0;
const ICSR_VECTACTIVE_MASK = 0x1ff;

/**
 * M33 CPUID value per datasheet §3.7.5.
 * Bits:
 *   [31:24]  implementer = 0x41 (ARM)
 *   [23:20]  variant     = 0x0  (r0p0 family — exact variant from datasheet)
 *   [19:16]  constant    = 0xF
 *   [15:8]   part number = 0xD21 (Cortex-M33)
 *   [7:4]    revision    = 0x0
 *   [3:0]    patch        = 0x1
 */
const M33_CPUID = 0x410fd213;

/** RP2350 M33 supports 52 external interrupts (datasheet §3.7.2 IRQLVL). */
const NUM_EXTERNAL_IRQS = 52;
/** Top-4 priority bits → 16 priority levels (datasheet §3.7.2 IRQLVL=4). */
const NUM_PRIORITY_LEVELS = 16;
/** Priority stored as 4-bit field per IRQ in two u32 banks of 32. */
const PRIORITY_MASK = NUM_PRIORITY_LEVELS - 1;

/** A single MPU/SAU region's base + limit/attribute register pair. */
export interface RegionPair {
  rbar: number;
  rlar: number;
}

/**
 * Per-core PPB state visible to the Cortex-M33Core via the chip's ppb field.
 * Defined here (not on the core itself) to keep the chip-level MMIO routing
 * in one place; the core reaches it via `chip.ppb.coreState[coreIndex]`.
 */
export interface M33CoreState {
  // NVIC pending/enable/active bitmasks — 2 banks × 32 bits = 64 (52 used).
  nvicPending: [number, number];
  nvicEnabled: [number, number];
  nvicActive: [number, number];
  // Per-IRQ priority (4 bits each, top nibble of byte per ARMv8-M).
  nvicPriority: Uint8Array;
  // System exception pending flags.
  pendingNMI: boolean;
  pendingPendSV: boolean;
  pendingSystick: boolean;
  // VTOR (secure alias only in v1).
  vtor: number;
  // SCB scratch for AIRCR / SCR / CCR / SHCSR / CFSR / HFSR / CPACR.
  aircr: number;
  scr: number;
  ccr: number;
  shcsr: number;
  cfsr: number;
  hfsr: number;
  cpacr: number;
  shpr2: number;
  shpr3: number;
  // Floating-point context registers.
  fpccr: number;
  fpcar: number;
  fpdscr: number;
  // DCP (double-precision coprocessor): 8 doubles × 2 u32 halves.
  dcpHalves: Uint32Array;
  dcpStatus: number;
  // RCP (redundancy coprocessor): per-core salt + count.
  rcpSalt: number;
  rcpSaltValid: boolean;
  rcpCount: number;
  // MPU state (8 regions).
  mpuCtrl: number;
  mpuRnr: number;
  mpuRegions: RegionPair[];
  mpuMair: [number, number];
  // SAU state (8 regions).
  sauCtrl: number;
  sauRnr: number;
  sauRegions: RegionPair[];
  sfsr: number;
  sfar: number;
  // SysTick per-core.
  systickCountFlag: boolean;
  systickClkSource: boolean;
  systickIntEnable: boolean;
  systickReload: number;
  readonly systickTimer: Timer32;
  readonly systickAlarm: Timer32PeriodicAlarm;
}

/**
 * Per-core M33 PPB state. Lives here (not on the core itself) to match the
 * existing RP2040 PPB convention; the Cortex-M33Core accesses it via
 * `chip.ppb.coreState[coreIndex]`.
 */
/** Fires the per-core SysTick reload/interrupt; a dedicated class (rather than
 * RPPPB2350 implementing AlarmCallback itself) since there are two per-core
 * instances, each needing its own coreIndex. */
class SystickAlarmCallback implements AlarmCallback {
  constructor(
    private readonly ppb: RPPPB2350,
    private readonly rpchip: RP2350,
    private readonly systickTimer: Timer32,
    private readonly coreIndex: number
  ) {}

  fire() {
    const st = this.ppb.coreState[this.coreIndex];
    st.systickCountFlag = true;
    if (st.systickIntEnable) {
      st.pendingSystick = true;
      // Notify the core — it will check pendingSystick on each step.
      const core = this.rpchip.core[this.coreIndex];
      core.interruptsUpdated = true;
    }
    this.systickTimer.set(st.systickReload);
  }
}

export class RPPPB2350<ChipType extends IRPChip = IRPChip> extends BasePeripheral<ChipType> {
  /** Per-core state (index 0 = core 0, index 1 = core 1). */
  readonly coreState: [M33CoreState, M33CoreState];

  constructor(rp2350: ChipType, name: string) {
    super(rp2350, name);
    this.coreState = [this.makeCoreState(0), this.makeCoreState(1)];
  }

  private makeCoreState(coreIndex: number): M33CoreState {
    const systickTimer = new Timer32(
      'M33_SysTick',
      this.rpchip.clock as SimulationClock,
      this.rpchip.clkSys
    );
    systickTimer.top = 0xffffff;
    systickTimer.mode = TimerMode.Decrement;
    // Real SysTick starts disabled (SYST_CSR.ENABLE=0) until firmware writes
    // SYST_CSR — `Timer32`'s own constructor defaults `enable` to `true`,
    // which the line below overrides. Without this, `systickAlarm.enable =
    // true` (below) schedules its periodic alarm immediately at
    // construction, with the default target=0 and an uninitialized
    // (zero) reload: `Timer32PeriodicAlarm.schedule()` computes a
    // zero-cycle/zero-nanosecond delay for that state, and the alarm's own
    // callback reloads to the same zero value and reschedules again with
    // the same zero delay — an infinite same-tick reschedule loop the very
    // first time anything calls `clock.tick()` (e.g. `RP2350.step()`),
    // before any CPU instruction has even run.
    systickTimer.enable = false;
    const systickAlarm = new Timer32PeriodicAlarm(
      'M33_SysTick_Alarm',
      systickTimer,
      new SystickAlarmCallback(this, this.rpchip as unknown as RP2350, systickTimer, coreIndex)
    );
    systickAlarm.target = 0;
    systickAlarm.enable = true;
    return {
      nvicPending: [0, 0],
      nvicEnabled: [0, 0],
      nvicActive: [0, 0],
      nvicPriority: new Uint8Array(NUM_EXTERNAL_IRQS),
      pendingNMI: false,
      pendingPendSV: false,
      pendingSystick: false,
      vtor: 0,
      aircr: 0,
      scr: 0,
      ccr: 0,
      shcsr: 0,
      cfsr: 0,
      hfsr: 0,
      cpacr: 0,
      shpr2: 0,
      shpr3: 0,
      fpccr: 0,
      fpcar: 0,
      fpdscr: 0,
      dcpHalves: new Uint32Array(16),
      dcpStatus: 0,
      rcpSalt: 0,
      rcpSaltValid: false,
      rcpCount: 0,
      mpuCtrl: 0,
      mpuRnr: 0,
      mpuRegions: Array.from({ length: 8 }, () => ({ rbar: 0, rlar: 0 })),
      mpuMair: [0, 0],
      sauCtrl: 0,
      sauRnr: 0,
      sauRegions: Array.from({ length: 8 }, () => ({ rbar: 0, rlar: 0 })),
      sfsr: 0,
      sfar: 0,
      systickCountFlag: false,
      systickClkSource: false,
      systickIntEnable: false,
      systickReload: 0,
      systickTimer,
      systickAlarm,
    };
  }

  readUint32ViaCore(offset: number, core: number): number {
    const st = this.coreState[core];

    // SCB block.
    if (offset === SCB_CPUID) return M33_CPUID;

    if (offset === SCB_ICSR) {
      const hasPending =
        st.nvicPending[0] !== 0 || st.nvicPending[1] !== 0 || st.pendingPendSV || st.pendingSystick;
      // VECTPENDING: lowest pending vector number (system exception or NVIC).
      let vectPending = 0;
      if (st.pendingNMI) {
        vectPending = 2;
      } else if (hasPending) {
        vectPending = this.lowestPendingVector(st);
      }
      // VECTACTIVE: current exception (0 = Thread mode). Read from core IPSR.
      const coreRegs = this.coreRegs(core);
      const vectActive = coreRegs.ipsr;
      return (
        (st.pendingNMI ? ICSR_NMIPENDSET : 0) |
        (st.pendingPendSV ? ICSR_PENDSVSET : 0) |
        (st.pendingSystick ? ICSR_PENDSTSET : 0) |
        (hasPending || st.pendingNMI ? ICSR_ISRPENDING : 0) |
        ((vectPending & ICSR_VECTPENDING_MASK) << ICSR_VECTPENDING_SHIFT) |
        ((vectActive & ICSR_VECTACTIVE_MASK) << ICSR_VECTACTIVE_SHIFT)
      );
    }

    if (offset === SCB_VTOR) return st.vtor;
    if (offset === SCB_AIRCR) return st.aircr;
    if (offset === SCB_SCR) return st.scr;
    if (offset === SCB_CCR) return st.ccr;
    if (offset === SCB_SHCSR) return st.shcsr;
    if (offset === SCB_CFSR) return st.cfsr;
    if (offset === SCB_HFSR) return st.hfsr;
    if (offset === SCB_CPACR) return st.cpacr;

    // System handler priority registers — top bits of each byte give the
    // priority for one system exception ( SVC/PendSV/SysTick).
    if (offset === SCB_SHPR2) return st.shpr2;
    if (offset === SCB_SHPR3) return st.shpr3;

    // Floating-point registers.
    if (offset === SCB_FPCCR) return st.fpccr;
    if (offset === SCB_FPCAR) return st.fpcar;
    if (offset === SCB_FPDSCR) return st.fpdscr;
    if (offset === SCB_MVFR0) return 0x10110021; // FPv5-SP feature bits
    if (offset === SCB_MVFR1) return 0x00000000;
    if (offset === SCB_MVFR2) return 0x00000040;

    // MPU registers.
    if (offset === MPU_TYPE) return 0x00000800; // 8 regions, unified
    if (offset === MPU_CTRL) return st.mpuCtrl;
    if (offset === MPU_RNR) return st.mpuRnr;
    if (offset === MPU_RBAR || offset === MPU_RLAR) {
      const r = st.mpuRegions[st.mpuRnr & 0x7];
      return offset === MPU_RBAR ? r.rbar : r.rlar;
    }
    if (offset === MPU_MAIR0) return st.mpuMair[0];
    if (offset === MPU_MAIR1) return st.mpuMair[1];

    // SAU registers.
    if (offset === SAU_CTRL) return st.sauCtrl;
    if (offset === SAU_TYPE) return 8; // 8 regions
    if (offset === SAU_RNR) return st.sauRnr;
    if (offset === SAU_RBAR || offset === SAU_RLAR) {
      const r = st.sauRegions[st.sauRnr & 0x7];
      return offset === SAU_RBAR ? r.rbar : r.rlar;
    }
    if (offset === SCB_SFSR) return st.sfsr;
    if (offset === SCB_SFAR) return st.sfar;

    // NVIC banks.
    if (offset === NVIC_BASE + NVIC_ISER0 || offset === NVIC_BASE + NVIC_ICER0)
      return st.nvicEnabled[0] >>> 0;
    if (offset === NVIC_BASE + NVIC_ISER1 || offset === NVIC_BASE + NVIC_ICER1)
      return st.nvicEnabled[1] >>> 0;
    if (offset === NVIC_BASE + NVIC_ISPR0 || offset === NVIC_BASE + NVIC_ICPR0)
      return st.nvicPending[0] >>> 0;
    if (offset === NVIC_BASE + NVIC_ISPR1 || offset === NVIC_BASE + NVIC_ICPR1)
      return st.nvicPending[1] >>> 0;
    if (offset === NVIC_BASE + NVIC_IABR0) return st.nvicActive[0] >>> 0;
    if (offset === NVIC_BASE + NVIC_IABR1) return st.nvicActive[1] >>> 0;

    // NVIC priority registers — 4 IRQs per reg, top nibble of each byte.
    if (
      offset >= NVIC_BASE + NVIC_IPR0 &&
      offset <= NVIC_BASE + NVIC_IPR_LAST &&
      (offset & 0x3) === 0
    ) {
      const regIndex = (offset - (NVIC_BASE + NVIC_IPR0)) >>> 2;
      let result = 0;
      for (let byteIndex = 0; byteIndex < 4; byteIndex++) {
        const irq = regIndex * 4 + byteIndex;
        if (irq < NUM_EXTERNAL_IRQS) {
          result |= (st.nvicPriority[irq] & PRIORITY_MASK) << (8 * byteIndex + 4);
        }
      }
      return result;
    }

    // SysTick.
    if (offset === SYSTICK_BASE + SYST_CSR) {
      const countFlagValue = st.systickCountFlag ? 1 << 16 : 0;
      const clkSourceValue = st.systickClkSource ? 1 << 2 : 0;
      const tickIntValue = st.systickIntEnable ? 1 << 1 : 0;
      const enableFlagValue = st.systickTimer.enable ? 1 << 0 : 0;
      st.systickCountFlag = false;
      return countFlagValue | clkSourceValue | tickIntValue | enableFlagValue;
    }
    if (offset === SYSTICK_BASE + SYST_CVR) return st.systickTimer.counter;
    if (offset === SYSTICK_BASE + SYST_RVR) return st.systickReload;
    if (offset === SYSTICK_BASE + SYST_CALIB) return 0x0000270f;

    return super.readUint32ViaCore(offset, core);
  }

  writeUint32ViaCore(offset: number, value: number, core: number): void {
    const st = this.coreState[core];

    if (offset === SCB_ICSR) {
      if (value & ICSR_NMIPENDSET) {
        st.pendingNMI = true;
        this.markInterruptsUpdated(core);
      }
      if (value & ICSR_PENDSVSET) {
        st.pendingPendSV = true;
        this.markInterruptsUpdated(core);
      }
      if (value & ICSR_PENDSVCLR) st.pendingPendSV = false;
      if (value & ICSR_PENDSTSET) {
        st.pendingSystick = true;
        this.markInterruptsUpdated(core);
      }
      if (value & ICSR_PENDSTCLR) st.pendingSystick = false;
      return;
    }

    if (offset === SCB_VTOR) {
      st.vtor = value & 0xffffff00;
      return;
    }
    if (offset === SCB_AIRCR) {
      // Honor the VECTKEY lock token (high half must be 0x05FA).
      if (value >>> 16 !== 0x05fa) return;
      st.aircr = value;
      return;
    }
    if (offset === SCB_SCR) {
      st.scr = value;
      return;
    }
    if (offset === SCB_CCR) {
      st.ccr = value;
      return;
    }
    if (offset === SCB_SHCSR) {
      st.shcsr = value;
      return;
    }
    if (offset === SCB_CFSR) {
      // W1C semantics on fault-status bits.
      st.cfsr &= ~value;
      return;
    }
    if (offset === SCB_HFSR) {
      st.hfsr &= ~value;
      return;
    }
    if (offset === SCB_CPACR) {
      st.cpacr = value;
      return;
    }
    if (offset === SCB_SHPR2) {
      st.shpr2 = value;
      return;
    }
    if (offset === SCB_SHPR3) {
      st.shpr3 = value;
      return;
    }

    // Floating-point registers.
    if (offset === SCB_FPCCR) {
      st.fpccr = value;
      return;
    }
    if (offset === SCB_FPCAR) {
      st.fpcar = value & ~0x3;
      return;
    }
    if (offset === SCB_FPDSCR) {
      st.fpdscr = value;
      return;
    }

    // MPU registers.
    if (offset === MPU_CTRL) {
      st.mpuCtrl = value & 0x7;
      return;
    }
    if (offset === MPU_RNR) {
      st.mpuRnr = value & 0x7;
      return;
    }
    if (offset === MPU_RBAR) {
      st.mpuRegions[st.mpuRnr & 0x7].rbar = value;
      return;
    }
    if (offset === MPU_RLAR) {
      st.mpuRegions[st.mpuRnr & 0x7].rlar = value;
      return;
    }
    if (offset === MPU_MAIR0) {
      st.mpuMair[0] = value;
      return;
    }
    if (offset === MPU_MAIR1) {
      st.mpuMair[1] = value;
      return;
    }

    // SAU registers.
    if (offset === SAU_CTRL) {
      st.sauCtrl = value & 0x3;
      return;
    }
    if (offset === SAU_RNR) {
      st.sauRnr = value & 0x7;
      return;
    }
    if (offset === SAU_RBAR) {
      st.sauRegions[st.sauRnr & 0x7].rbar = value;
      return;
    }
    if (offset === SAU_RLAR) {
      st.sauRegions[st.sauRnr & 0x7].rlar = value;
      return;
    }
    if (offset === SCB_SFSR) {
      st.sfsr &= ~value; // W1C
      return;
    }

    // NVIC enable/clear/pending registers.
    if (offset === NVIC_BASE + NVIC_ISER0) {
      st.nvicEnabled[0] |= value;
      this.markInterruptsUpdated(core);
      return;
    }
    if (offset === NVIC_BASE + NVIC_ISER1) {
      st.nvicEnabled[1] |= value & ((1 << (NUM_EXTERNAL_IRQS - 32)) - 1 || 0xffffffff);
      this.markInterruptsUpdated(core);
      return;
    }
    if (offset === NVIC_BASE + NVIC_ICER0) {
      st.nvicEnabled[0] &= ~value;
      return;
    }
    if (offset === NVIC_BASE + NVIC_ICER1) {
      st.nvicEnabled[1] &= ~value;
      return;
    }
    if (offset === NVIC_BASE + NVIC_ISPR0) {
      st.nvicPending[0] |= value;
      this.markInterruptsUpdated(core);
      return;
    }
    if (offset === NVIC_BASE + NVIC_ISPR1) {
      st.nvicPending[1] |= value;
      this.markInterruptsUpdated(core);
      return;
    }
    if (offset === NVIC_BASE + NVIC_ICPR0) {
      st.nvicPending[0] &= ~value;
      return;
    }
    if (offset === NVIC_BASE + NVIC_ICPR1) {
      st.nvicPending[1] &= ~value;
      return;
    }

    // NVIC priority registers.
    if (
      offset >= NVIC_BASE + NVIC_IPR0 &&
      offset <= NVIC_BASE + NVIC_IPR_LAST &&
      (offset & 0x3) === 0
    ) {
      const regIndex = (offset - (NVIC_BASE + NVIC_IPR0)) >>> 2;
      for (let byteIndex = 0; byteIndex < 4; byteIndex++) {
        const irq = regIndex * 4 + byteIndex;
        if (irq < NUM_EXTERNAL_IRQS) {
          const newPriority = (value >>> (8 * byteIndex + 4)) & PRIORITY_MASK;
          st.nvicPriority[irq] = newPriority;
        }
      }
      this.markInterruptsUpdated(core);
      return;
    }

    // SysTick.
    if (offset === SYSTICK_BASE + SYST_CSR) {
      st.systickClkSource = (value & (1 << 2)) !== 0;
      st.systickIntEnable = (value & (1 << 1)) !== 0;
      st.systickTimer.enable = (value & 1) !== 0;
      return;
    }
    if (offset === SYSTICK_BASE + SYST_CVR) {
      st.systickTimer.set(0);
      // ARMv8-M §B3.3: a CVR write of any value also clears COUNTFLAG.
      st.systickCountFlag = false;
      return;
    }
    if (offset === SYSTICK_BASE + SYST_RVR) {
      st.systickReload = value;
      return;
    }

    super.writeUint32ViaCore(offset, value, core);
  }

  /** Helper to fetch the M33Registers for a given core index. */
  private coreRegs(core: number) {
    // Cast to CortexM33Core directly (RP2350's cores are always that concrete type)
    // rather than an anonymous shape — cts2c needs a real, known class to resolve
    // field access against, not an inline type.
    const coreObj = this.rpchip.core[core] as unknown as CortexM33Core;
    return coreObj.regs;
  }

  /** Same reasoning as coreRegs() — ICpuCore has no `interruptsUpdated` property. */
  private markInterruptsUpdated(core: number) {
    const coreObj = this.rpchip.core[core] as unknown as CortexM33Core;
    coreObj.interruptsUpdated = true;
  }

  /**
   * Find the lowest-numbered pending external or system exception vector.
   * Used by ICSR reads. Caller must have already confirmed *some* exception
   * is pending. Returns the vector number (16+ for external IRQs, lower for
   * PendSV=14 / SysTick=15).
   */
  private lowestPendingVector(st: M33CoreState): number {
    // System exceptions (lower vector numbers take precedence at the same
    // priority; we report the lowest *vector number*).
    if (st.pendingPendSV) return 14;
    if (st.pendingSystick) return 15;
    for (let bank = 0; bank < 2; bank++) {
      const pending = st.nvicPending[bank];
      if (pending) {
        for (let bit = 0; bit < 32; bit++) {
          if (pending & (1 << bit)) {
            return 16 + bank * 32 + bit;
          }
        }
      }
    }
    return 0;
  }
}
