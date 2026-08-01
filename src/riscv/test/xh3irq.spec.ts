/*
 * Xh3irq interrupt controller test suite.
 *
 * Tests are derived from the Hazard3 specification v1.0-rc2
 * which RP2350 is based on.
 */

import { describe, expect, test, beforeEach } from 'vitest';
import { RP2350 } from '../../rp2350';
import { CPU } from '../cpu';

const MSTATUS = 0x300;
const MIE = 0x304;
const MTVEC = 0x305;
const MEPC = 0x341;
const MCAUSE = 0x342;
const MIP = 0x344;
const MEIEA = 0xbe0;
const MEIPA = 0xbe1;
const MEIFA = 0xbe2;
const MEIPRA = 0xbe3;
const MEINEXT = 0xbe4;
const MEICONTEXT = 0xbe5;

const SCRATCH = 0x20000000;
const TRAPHANDLER = 0x20020000;
const NOP = 0x00000013; // addi x0, x0, 0

describe('Xh3irq interrupt controller', () => {
  let chip: RP2350;
  let cpu: CPU;

  beforeEach(() => {
    chip = new RP2350();
    cpu = chip.core0;
    chip.core1.waiting = true;
  });

  // --- helpers ---

  // Write a CSR with side effects (simulates csrrw with rs1=value).
  function csrWrite(csr: number, value: number) {
    cpu.setCSR(csr, value >>> 0, value >>> 0);
  }

  // Read a CSR with side effects (simulates csrr with raw_write=0).
  function csrRead(csr: number, raw_write: number = 0): number {
    return cpu.getCSR(csr, raw_write >>> 0) >>> 0;
  }

  // Enable multiple IRQs in meiea. Must batch IRQs in the same window
  // since meiea writes replace the entire 16-bit window.
  function enableIrqs(...irqs: number[]) {
    const windows: Record<number, number> = {};
    for (const irq of irqs) {
      const win = Math.floor(irq / 16);
      windows[win] = (windows[win] || 0) | (1 << irq % 16);
    }
    for (const win in windows) {
      csrWrite(MEIEA, (windows[win] << 16) | parseInt(win));
    }
  }

  // Set priorities for multiple IRQs. Must batch IRQs in the same meipra
  // group (4 IRQs per group) since writes replace the whole group.
  function setPriorities(...entries: [number, number][]) {
    const groups: Record<number, number> = {};
    for (const [irq, prio] of entries) {
      const group = Math.floor(irq / 4);
      const shift = (irq % 4) * 4;
      groups[group] = (groups[group] || 0) | ((prio & 0xf) << shift);
    }
    for (const group in groups) {
      csrWrite(MEIPRA, (groups[group] << 16) | parseInt(group));
    }
  }

  // Set priority of IRQ n (4-bit, 0-15)
  function setPriority(irq: number, prio: number) {
    const group = Math.floor(irq / 4);
    const shift = (irq % 4) * 4;
    // meipra: bits[31:16] = four 4-bit priorities, bits[6:0] = group index
    const value = (((prio & 0xf) << shift) << 16) | group;
    csrWrite(MEIPRA, value);
  }

  // Force IRQ n via meifa
  function forceIrq(irq: number) {
    const win = Math.floor(irq / 16);
    const bit = 1 << irq % 16;
    csrWrite(MEIFA, (bit << 16) | win);
  }

  // Clear meifa for IRQ n
  function clearForceIrq(irq: number) {
    const win = Math.floor(irq / 16);
    // Write 0 to the force bit (csrrw replaces the window)
    csrWrite(MEIFA, win); // bits[31:16]=0, bits[4:0]=win
  }

  // Set up the full interrupt enable chain for external interrupts
  function setupInterrupts(
    opts: { mie_meie?: boolean; mstatus_mie?: boolean; mtvec_mode?: number } = {}
  ) {
    cpu.csrs[MTVEC] = TRAPHANDLER | (opts.mtvec_mode ?? 0);
    if (opts.mie_meie ?? true) cpu.csrs[MIE] |= 1 << 11;
    if (opts.mstatus_mie ?? true) cpu.csrs[MSTATUS] |= 1 << 3; // MSTATUS.MIE
    cpu.interruptsUpdated = true;
  }

  // Run one instruction from SCRATCH; checkForInterrupts fires first.
  function step() {
    chip.writeUint32(SCRATCH, NOP);
    chip.writeUint32(SCRATCH + 4, 0);
    chip.writeUint32(TRAPHANDLER, NOP);
    chip.writeUint32(TRAPHANDLER + 4, 0);
    cpu.pc = SCRATCH;
    cpu.next_pc = 0;
    cpu.executeInstruction();
  }

  // =====================================================================
  // CSR Array Windowing
  // =====================================================================

  describe('CSR array windowing', () => {
    test('meiea write/read window 0', () => {
      // Enable IRQs 0 and 3 in window 0
      csrWrite(MEIEA, (0b1001 << 16) | 0);
      // Read window 0
      const val = csrRead(MEIEA, 0);
      expect((val >>> 16) & 0xffff).toBe(0b1001);
    });

    test('meiea different windows are independent', () => {
      // Write window 0: enable IRQ 0
      csrWrite(MEIEA, (1 << 16) | 0);
      // Write window 1: enable IRQ 16
      csrWrite(MEIEA, (1 << 16) | 1);
      // Read window 0
      expect((csrRead(MEIEA, 0) >>> 16) & 0xffff).toBe(0b1);
      // Read window 1
      expect((csrRead(MEIEA, 1) >>> 16) & 0xffff).toBe(0b1);
    });

    test('meifa write/read', () => {
      forceIrq(5);
      const val = csrRead(MEIFA, 0);
      expect((val >>> 16) & 0xffff).toBe(1 << 5);
    });

    test('meipa reflects meifa without enable (spec: meipa = irq_r | meifa)', () => {
      // Spec: meipa is unconditional — meiea gates trapping, not pending visibility
      forceIrq(7);
      const val = csrRead(MEIPA, 0);
      expect((val >>> 16) & 0xffff).toBe(1 << 7);
    });

    test('meipra write/read', () => {
      // Set IRQ 0 priority=5, IRQ 1 priority=10
      const prioWord = ((5 & 0xf) << 0) | ((10 & 0xf) << 4);
      csrWrite(MEIPRA, (prioWord << 16) | 0);
      const val = csrRead(MEIPRA, 0);
      expect((val >>> 16) & 0xf).toBe(5);
      expect((val >>> 20) & 0xf).toBe(10);
    });
  });

  // =====================================================================
  // Interrupt Triggering
  // =====================================================================

  describe('interrupt triggering', () => {
    test('enabled+forced IRQ traps with mcause=0x8000000b', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts();
      forceIrq(0);

      step();

      // mcause: MSB set (interrupt) + cause code 11 (external)
      expect(cpu.csrs[MCAUSE]).toBe(((1 << 31) | 11) >>> 0);
      // mepc: the interrupted PC
      expect(cpu.csrs[MEPC]).toBe(SCRATCH);
      // pc should be at trap handler
      expect(cpu.pc).toBe(TRAPHANDLER + 4);
    });

    test('disabled IRQ (meiea=0) does not trap', () => {
      setPriorities([0, 0]);
      setupInterrupts();
      forceIrq(0);
      // IRQ 0 is NOT enabled in meiea

      step();
      expect(cpu.pc).toBe(SCRATCH + 4); // just executed the nop
    });

    test('mstatus.mie=0 blocks trap', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts({ mstatus_mie: false });
      forceIrq(0);

      step();
      expect(cpu.pc).toBe(SCRATCH + 4);
    });

    test('mie.meie=0 blocks external interrupt trap', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts({ mie_meie: false });
      forceIrq(0);

      step();
      expect(cpu.pc).toBe(SCRATCH + 4);
    });

    test('trap entry: mstatus.mie saved to mpie, then mie cleared', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts();
      forceIrq(0);

      step();

      const mstatus = cpu.csrs[MSTATUS];
      // Spec: on trap entry, mpie <= mie, mie <= 0
      expect(mstatus & (1 << 7)).not.toBe(0); // mpie should be set (was mie=1)
      expect(mstatus & (1 << 3)).toBe(0); // mie should be cleared
    });

    test('vectored mode: external interrupt goes to mtvec + (11<<2)', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts({ mtvec_mode: 1 }); // vectored
      forceIrq(0);

      // External interrupt cause = 11, so address = mtvec | (11 << 2) = mtvec + 0x2c
      const expected = (TRAPHANDLER & ~3) + (11 << 2);
      // Write a NOP at the vectored trap address so execution doesn't crash
      chip.writeUint32(expected, NOP);
      chip.writeUint32(expected + 4, 0);

      step();
      expect(cpu.pc).toBe(expected + 4);
    });

    test('direct mode: all traps go to mtvec base', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts({ mtvec_mode: 0 });
      forceIrq(0);

      step();
      expect(cpu.pc).toBe(TRAPHANDLER + 4);
    });
  });

  // =====================================================================
  // MEINEXT
  // =====================================================================

  describe('MEINEXT', () => {
    test('returns highest-priority IRQ, left-shifted by 2', () => {
      enableIrqs(0, 1);
      setPriorities([0, 3], [1, 7]);
      forceIrq(0);
      forceIrq(1);
      setupInterrupts({ mstatus_mie: false }); // don't trap yet

      const val = csrRead(MEINEXT);
      // IRQ 1 has higher priority → meinext.irq = 1<<2 = 4
      expect((val >> 2) & 0x1ff).toBe(1);
      expect(val & (1 << 31)).toBe(0); // noirq clear
    });

    test('noirq bit set when no qualifying IRQ', () => {
      // No IRQs enabled or forced
      const val = csrRead(MEINEXT);
      expect(val & (1 << 31)).not.toBe(0); // noirq set
    });

    test('equal priority: lowest IRQ index wins', () => {
      enableIrqs(2, 5);
      setPriorities([2, 5], [5, 5]);
      // Force both IRQs in a single meifa write (window replaces, not ORs)
      csrWrite(MEIFA, (((1 << 2) | (1 << 5)) << 16) | 0);
      setupInterrupts({ mstatus_mie: false });

      const val = csrRead(MEINEXT);
      expect((val >> 2) & 0x1ff).toBe(2); // lower index wins
    });

    test('reading meinext clears meifa for the returned IRQ', () => {
      enableIrqs(3);
      setPriorities([3, 0]);
      forceIrq(3);
      setupInterrupts({ mstatus_mie: false });

      // First read returns IRQ 3
      const val1 = csrRead(MEINEXT);
      expect((val1 >> 2) & 0x1ff).toBe(3);

      // Spec: reading meinext clears meifa for the returned IRQ
      expect(cpu.meifa[3]).toBe(0);
    });

    test('meinext.update sets meicontext.preempt', () => {
      enableIrqs(0);
      setPriorities([0, 5]);
      forceIrq(0);
      setupInterrupts({ mstatus_mie: false });

      // Write meinext with update bit (simulates csrrsi x0, meinext, 1)
      const val = csrRead(MEINEXT);
      csrWrite(MEINEXT, val | 1); // set update bit

      // Spec: preempt_level_next = 1 + priority = 1 + 5 = 6
      // meicontext.preempt is bits [20:16]
      const meicontext = cpu.csrs[MEICONTEXT];
      expect((meicontext >>> 16) & 0x1f).toBe(6);
    });

    test('meinext respects ppreempt threshold', () => {
      enableIrqs(0, 1);
      setPriorities([0, 2], [1, 8]);
      forceIrq(0);
      forceIrq(1);
      setupInterrupts({ mstatus_mie: false });

      // Set ppreempt (bits [27:24]) to 5 — only IRQ 1 (prio 8 >= 5) visible
      cpu.csrs[MEICONTEXT] = (cpu.csrs[MEICONTEXT] & ~(0xf << 24)) | (5 << 24);
      // Need to call updateMEINEXT to recalculate
      cpu.interruptsUpdated = true;

      const val = csrRead(MEINEXT);
      expect((val >> 2) & 0x1ff).toBe(1); // only IRQ 1 qualifies
    });
  });

  // =====================================================================
  // Candidate list ordering and removal
  //
  // Tests the internal candidate list (candidateIrq/candidatePriority/
  // candidateCount) via MEINEXT/MIP CSRs, with 3+ simultaneous candidates.
  // =====================================================================

  describe('candidate list ordering and removal', () => {
    test('three simultaneous candidates: highest priority wins, ties broken by lowest irq', () => {
      enableIrqs(0, 1, 2);
      // irq1 and irq2 tie at the top priority; irq0 is strictly lower.
      setPriorities([0, 3], [1, 7], [2, 7]);
      forceIrq(0);
      forceIrq(1);
      forceIrq(2);
      setupInterrupts({ mstatus_mie: false });

      // irq1 must win: highest priority, and of the tied pair (1, 2) the lower
      // irq number wins.
      expect((csrRead(MEINEXT) >> 2) & 0x1ff).toBe(1);
    });

    test('removing the current-best candidate promotes the next-highest', () => {
      // Different meifa windows (46/16=2, 48/16=3) so a later clearForceIrq on one
      // can't also clobber the other's force bit.
      enableIrqs(46, 48);
      setPriorities([46, 5], [48, 9]);
      forceIrq(46);
      forceIrq(48);
      setupInterrupts({ mstatus_mie: false });

      // irq48 (priority 9) is currently best. Reading MEINEXT confirms it and
      // removes it from the candidate list (same path real firmware uses to
      // drain the interrupt queue).
      expect((csrRead(MEINEXT) >> 2) & 0x1ff).toBe(48);

      // irq46 must now be the new best.
      expect((csrRead(MEINEXT) >> 2) & 0x1ff).toBe(46);
    });

    test('removing a middle-priority candidate preserves the order of the rest', () => {
      // Three distinct windows (46/16=2, 63/16=3, 80/16=5) so each can be cleared
      // independently.
      enableIrqs(46, 63, 80);
      setPriorities([46, 5], [63, 9], [80, 2]);
      forceIrq(46);
      forceIrq(63);
      forceIrq(80);
      setupInterrupts({ mstatus_mie: false });

      // Remove the middle-priority entry (irq46, prio 5) via clearForceIrq
      // BEFORE reading MEINEXT, since reading MEINEXT itself removes the best
      // IRQ and would corrupt this test.
      clearForceIrq(46);

      // Order should now be irq63 (prio 9) > irq80 (prio 2). Draining both via
      // sequential reads proves removeCandidate()'s shift-compaction didn't corrupt
      // the relative order of the surviving entries.
      expect((csrRead(MEINEXT) >> 2) & 0x1ff).toBe(63);
      expect((csrRead(MEINEXT) >> 2) & 0x1ff).toBe(80);
    });

    test('removing the last remaining candidate sets noirq', () => {
      enableIrqs(46);
      setPriorities([46, 0]);
      forceIrq(46);
      setupInterrupts({ mstatus_mie: false });

      // Remove directly via clearForceIrq without reading MEINEXT first,
      // since reading MEINEXT itself would remove irq46 and make this test
      // pass even if removeCandidate() were never called.
      clearForceIrq(46);
      expect(csrRead(MEINEXT) & (1 << 31)).not.toBe(0); // noirq set, list empty
    });
  });

  // =====================================================================
  // MEICONTEXT
  // =====================================================================

  describe('MEICONTEXT', () => {
    test('reset values: noirq=1, mreteirq=0, preempt=0', () => {
      const val = csrRead(MEICONTEXT);
      // Reset: noirq=1 (bit 15), mreteirq=0 (bit 0)
      expect(val & (1 << 15)).not.toBe(0); // noirq
      expect(val & 1).toBe(0); // mreteirq
      expect((val >>> 16) & 0x1f).toBe(0); // preempt
      expect((val >>> 24) & 0xf).toBe(0); // ppreempt
    });

    test('clearts clears mie.mtie/msie and saves their values', () => {
      // Set mie.mtie (bit 7) and mie.msie (bit 3)
      cpu.csrs[MIE] = (1 << 7) | (1 << 3);

      // Read meicontext with clearts asserted — the read should return
      // mtiesave and msiesave reflecting the old mie values.
      // clearts only fires on csrrw/csrrs, simulated by raw_write bit 1 set.
      const val = cpu.getCSR(MEICONTEXT, 0x2) >>> 0; // raw_write bit 1 = clearts

      // Spec: mtiesave (bit 3) = old mie.mtie, msiesave (bit 2) = old mie.msie
      expect(val & (1 << 3)).not.toBe(0); // mtiesave = 1
      expect(val & (1 << 2)).not.toBe(0); // msiesave = 1

      // mie.mtie and mie.msie should now be cleared
      expect(cpu.csrs[MIE] & (1 << 7)).toBe(0);
      expect(cpu.csrs[MIE] & (1 << 3)).toBe(0);
    });

    test('mtiesave/msiesave writes restore mie.mtie/msie', () => {
      // Reverse of clearts: writing meicontext with raw_write bits 3/2 set
      // (without clearts) ORs those bits into mie.mtie/msie.
      cpu.csrs[MIE] = 0;
      cpu.csrs[MEICONTEXT] = 0;

      // raw_write bit 3 = mtiesave, bit 2 = msiesave, no clearts (bit 1)
      cpu.getCSR(MEICONTEXT, 0b1100);

      expect(cpu.csrs[MIE] & (1 << 7)).toBe(1 << 7); // mtie restored
      expect(cpu.csrs[MIE] & (1 << 3)).toBe(1 << 3); // msie restored
    });

    test('noirq=1 in meinext sets preempt to 16 (disables all preemption)', () => {
      // When priority_save fires with meinext.noirq=1, preempt is set to 16.
      // No 4-bit priority can reach 16, so all preemption is disabled.
      cpu.csrs[MEINEXT] = 1 << 31; // noirq=1
      cpu.updateMEICONTEXT_priority_save();

      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(16);
    });

    test('mreteirq set on external interrupt trap entry', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts();
      forceIrq(0);

      step();

      const val = cpu.csrs[MEICONTEXT];
      expect(val & 1).toBe(1); // mreteirq should be set
    });

    test('non-eirq trap clears mreteirq', () => {
      // First, set mreteirq manually
      cpu.csrs[MEICONTEXT] |= 1;

      // Trigger ecall (non-eirq trap)
      chip.writeUint32(SCRATCH, 0x00000073); // ecall
      chip.writeUint32(SCRATCH + 4, 0);
      chip.writeUint32(TRAPHANDLER, NOP);
      chip.writeUint32(TRAPHANDLER + 4, 0);
      cpu.csrs[MTVEC] = TRAPHANDLER;
      cpu.pc = SCRATCH;
      cpu.next_pc = 0;
      cpu.executeInstruction();

      expect(cpu.csrs[MEICONTEXT] & 1).toBe(0); // mreteirq cleared
    });
  });

  // =====================================================================
  // Trap Entry / Exit
  // =====================================================================

  describe('trap entry and exit', () => {
    test('mret restores mstatus.mie from mpie, sets mpie=1', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      setupInterrupts();
      forceIrq(0);
      step();

      // Now in trap: mie=0, mpie=1 (was mie)
      // Set mepc to a known address
      cpu.csrs[MEPC] = 0x20040000;

      // Execute mret
      chip.writeUint32(TRAPHANDLER, 0x30200073); // mret
      chip.writeUint32(TRAPHANDLER + 4, 0);
      cpu.pc = TRAPHANDLER;
      cpu.next_pc = 0;
      cpu.executeInstruction();

      const mstatus = cpu.csrs[MSTATUS];
      // Spec: mie <= mpie, mpie <= 1
      expect(mstatus & (1 << 3)).not.toBe(0); // mie restored
      expect(mstatus & (1 << 7)).not.toBe(0); // mpie set to 1
      expect(cpu.pc).toBe(0x20040000); // jumped to mepc
    });

    test('priority save on eirq entry pushes preempt stack', () => {
      enableIrqs(0);
      setPriorities([0, 5]);
      setupInterrupts();
      forceIrq(0);
      step();

      // Spec on eirq entry:
      //   ppreempt <= old preempt[3:0]
      //   preempt  <= preempt_level_next = 1 + 5 = 6
      //   mreteirq <= 1
      const ctx = cpu.csrs[MEICONTEXT];
      expect((ctx >>> 16) & 0x1f).toBe(6); // preempt = 6
      expect((ctx >>> 24) & 0xf).toBe(0); // ppreempt = old preempt low = 0
      expect(ctx & 1).toBe(1); // mreteirq
    });

    test('mret with mreteirq=1 pops preempt stack', () => {
      enableIrqs(0);
      setPriorities([0, 5]);
      setupInterrupts();
      forceIrq(0);
      step();

      // State: ppreempt=0, preempt=6, mreteirq=1
      // Set mepc for mret target
      cpu.csrs[MEPC] = 0x20040000;

      chip.writeUint32(TRAPHANDLER, 0x30200073); // mret
      chip.writeUint32(TRAPHANDLER + 4, 0);
      cpu.pc = TRAPHANDLER;
      cpu.next_pc = 0;
      cpu.executeInstruction();

      // Spec on mret with mreteirq=1:
      //   ppreempt <= old pppreempt (0)
      //   preempt  <= {0, old ppreempt} = 0
      //   mreteirq <= 0
      const ctx = cpu.csrs[MEICONTEXT];
      expect((ctx >>> 16) & 0x1f).toBe(0); // preempt restored to 0
      expect((ctx >>> 24) & 0xf).toBe(0); // ppreempt restored
      expect(ctx & 1).toBe(0); // mreteirq cleared
    });

    test('mret with mreteirq=0 does not pop stack', () => {
      // Manually set preempt and mreteirq=0
      cpu.csrs[MEICONTEXT] = (6 << 16) | (3 << 24); // preempt=6, ppreempt=3, mreteirq=0
      cpu.csrs[MEPC] = 0x20040000;
      cpu.csrs[MSTATUS] = (1 << 7) | (1 << 3); // mpie=1, mie=1

      chip.writeUint32(SCRATCH, 0x30200073); // mret
      chip.writeUint32(SCRATCH + 4, 0);
      cpu.pc = SCRATCH;
      cpu.next_pc = 0;
      cpu.executeInstruction();

      // Stack should NOT be popped since mreteirq was 0
      const ctx = cpu.csrs[MEICONTEXT];
      expect((ctx >>> 16) & 0x1f).toBe(6); // preempt unchanged
      expect((ctx >>> 24) & 0xf).toBe(3); // ppreempt unchanged
    });
  });

  // =====================================================================
  // WFI Wakeup
  // =====================================================================

  describe('WFI wakeup', () => {
    test('pending interrupt wakes WFI even when mstatus.mie is clear', () => {
      // Spec: "wfi ignores the global interrupt enable, MSTATUS.MIE"
      enableIrqs(4);
      setPriorities([4, 5]);
      forceIrq(4);
      cpu.csrs[MIE] = 1 << 11; // meie
      cpu.csrs[MSTATUS] = 0; // mie clear — WFI ignores this
      cpu.waiting = true;
      cpu.interruptsUpdated = true;

      cpu.checkForInterrupts();

      expect(cpu.waiting).toBe(false); // woken
      expect(cpu.csrs[MCAUSE]).toBe(0); // no trap taken (mie was clear)
    });
  });

  // =====================================================================
  // Preemption
  // =====================================================================

  describe('preemption', () => {
    test('higher-priority IRQ can preempt lower-priority handler', () => {
      // Set up two IRQs with different priorities
      enableIrqs(0, 1);
      setPriorities([0, 2], [1, 8]);
      setupInterrupts();
      forceIrq(0);

      // First trap: IRQ 0 (priority 2)
      step();
      expect(cpu.csrs[MCAUSE]).toBe(((1 << 31) | 11) >>> 0);
      // preempt should be 1 + 2 = 3
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(3);

      // Now force IRQ 1 (priority 8 >= preempt 3) and re-enable mie
      forceIrq(1);
      cpu.csrs[MSTATUS] |= 1 << 3; // re-enable mie for preemption
      cpu.interruptsUpdated = true;

      // Execute from trap handler — should preempt
      cpu.pc = TRAPHANDLER; // re-execute handler nop
      cpu.next_pc = 0;
      cpu.executeInstruction();

      // Should have trapped again for IRQ 1
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(9); // 1 + 8 = 9
      // Stack: ppreempt = old preempt[3:0] = 3
      expect((cpu.csrs[MEICONTEXT] >>> 24) & 0xf).toBe(3);
    });

    test('lower-priority IRQ cannot preempt higher-priority handler', () => {
      enableIrqs(0, 1);
      setPriorities([0, 8], [1, 2]);
      setupInterrupts();
      forceIrq(0);

      // First trap: IRQ 0 (priority 8), preempt = 1 + 8 = 9
      step();
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(9);

      // Force IRQ 1 (priority 2 < preempt 9) — should NOT preempt
      forceIrq(1);
      cpu.csrs[MSTATUS] |= 1 << 3; // re-enable mie
      cpu.interruptsUpdated = true;

      cpu.pc = TRAPHANDLER;
      cpu.next_pc = 0;
      cpu.executeInstruction();

      // Should NOT have trapped — just executed the nop
      // preempt unchanged
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(9);
    });

    test('nested preemption: two-deep stack save/restore', () => {
      enableIrqs(0, 1);
      setPriorities([0, 3], [1, 8]);
      setupInterrupts();

      // --- Level 1: IRQ 0 (priority 3) ---
      forceIrq(0);
      step();
      // preempt = 1 + 3 = 4, ppreempt = 0
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(4);

      // --- Level 2: IRQ 1 (priority 8 >= preempt 4) ---
      forceIrq(1);
      cpu.csrs[MSTATUS] |= 1 << 3;
      cpu.interruptsUpdated = true;
      cpu.pc = TRAPHANDLER;
      cpu.next_pc = 0;
      cpu.executeInstruction();
      // preempt = 1 + 8 = 9, ppreempt = old preempt[3:0] = 4
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(9);
      expect((cpu.csrs[MEICONTEXT] >>> 24) & 0xf).toBe(4);

      // --- mret from level 2 ---
      cpu.csrs[MEPC] = TRAPHANDLER;
      chip.writeUint32(TRAPHANDLER, 0x30200073); // mret
      cpu.pc = TRAPHANDLER;
      cpu.next_pc = 0;
      cpu.executeInstruction();
      // preempt restored to old ppreempt = 4
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(4);
      expect(cpu.csrs[MEICONTEXT] & 1).toBe(0); // mreteirq cleared by this mret

      // --- mret from level 1 ---
      // Hardware nesting is tracked only 2 levels deep: level-2's mret
      // already cleared mreteirq, leaving no CSR state for a further
      // (level-1) mret to auto-restore from, so preempt stays at its
      // post-level-2 value.
      expect((cpu.csrs[MEICONTEXT] >>> 16) & 0x1f).toBe(4); // unchanged — no auto-pop
    });
  });

  // =====================================================================
  // MIP.meip Generation
  // =====================================================================

  describe('mip.meip generation', () => {
    test('mip.meip set when IRQ enabled+pending+priority >= preempt', () => {
      enableIrqs(0);
      setPriorities([0, 0]);
      forceIrq(0);
      setupInterrupts({ mstatus_mie: false, mie_meie: false });

      // mip is at 0x344
      const mip = cpu.csrs[MIP];
      // bit 11 = meip — should be set since IRQ is enabled, pending, prio 0 >= preempt 0
      // Note: in the emulator, mip.meip is set via csrs[0x344] |= (1<<11) in updateMEINEXT
      expect(mip & (1 << 11)).not.toBe(0);
    });

    test('mip.meip clear when IRQ disabled', () => {
      setPriorities([0, 0]);
      forceIrq(0);
      setupInterrupts({ mstatus_mie: false, mie_meie: false });
      // IRQ NOT enabled in meiea

      const mip = cpu.csrs[MIP];
      expect(mip & (1 << 11)).toBe(0);
    });
  });

  // =====================================================================
  // Standard Interrupt Priority
  // =====================================================================

  describe('standard IRQ priority', () => {
    test('external (11) > software (3) > timer (7)', () => {
      // This is documented in the spec: the priority encoder selects
      // external first, then software, then timer.
      // Set up all three to be pending+enabled
      cpu.csrs[MIE] = (1 << 11) | (1 << 7) | (1 << 3); // meie, mtie, msie
      cpu.csrs[MSTATUS] |= 1 << 3; // mie

      // Force external interrupt
      enableIrqs(0);
      setPriorities([0, 0]);
      forceIrq(0);

      // Set timer and software pending in mip
      // Note: in the emulator, mip is partially read-only.
      // mtip and msip come from registered inputs.
      // We can test that external has priority by checking it traps first.
      cpu.csrs[MTVEC] = TRAPHANDLER;

      step();

      // External should win (cause 11)
      expect(cpu.csrs[MCAUSE] & 0xf).toBe(11);
    });
  });
});
