/*
 * Xh3power (h3.block / h3.unblock) test suite.
 *
 * Wake semantics per the Hazard3 RTL (hazard3_power_ctrl.v: a block sleep
 * ends on block_wakeup_req OR wfi_wakeup_req; the unblock latch is sticky
 * and consumed by each h3.block) and the RP2350 datasheet section 3.4: the
 * unblock signals are cross-connected between the two cores, and each
 * core's unblock output is also fed back into its own input.
 */

import { describe, expect, test, beforeEach } from 'vitest';
import { RP2350 } from '../../rp2350';
import { CPU } from '../cpu';

const MSTATUS = 0x300;
const MIE = 0x304;
const MTVEC = 0x305;
const MEPC = 0x341;
const MCAUSE = 0x342;
const MEIEA = 0xbe0;
const MEIPRA = 0xbe3;
const MEIFA = 0xbe2;

const SCRATCH = 0x20000000;
const TRAPHANDLER = 0x20020000;

const H3_BLOCK = 0x00002033; // slt x0, x0, x0
const H3_UNBLOCK = 0x00102033; // slt x0, x0, x1
const WFI = 0x10500073;
const NOP = 0x00000013; // addi x0, x0, 0

describe('Xh3power block/unblock', () => {
  let chip: RP2350;
  let cpu: CPU;

  beforeEach(() => {
    chip = new RP2350();
    cpu = chip.core0;
    chip.core1.waiting = true;
    chip.core1.waitingOnBlock = false;
  });

  function csrWrite(csr: number, value: number) {
    cpu.setCSR(csr, value >>> 0, value >>> 0);
  }

  // Execute a single instruction word through the full fetch/decode path.
  function exec(encoding: number) {
    chip.writeUint32(SCRATCH, encoding);
    chip.writeUint32(SCRATCH + 4, 0);
    cpu.pc = SCRATCH;
    cpu.next_pc = 0;
    cpu.executeInstruction();
  }

  // Enable IRQ 4 at priority 4 and force it pending via meifa.
  function forcePendingIrq() {
    csrWrite(MEIEA, (1 << (16 + 4)) | 0); // meiea window 0, bit 4
    csrWrite(MEIPRA, (4 << (16 + 0)) | 1); // meipra group 1 (irq 4), prio 4
    csrWrite(MEIFA, (1 << (16 + 4)) | 0); // meifa window 0, bit 4
    cpu.csrs[MIE] = 1 << 11; // meie
  }

  test('h3.block sleeps when no unblock latched and no interrupt pending', () => {
    exec(H3_BLOCK);
    expect(cpu.waiting).toBe(true);
    expect(cpu.waitingOnBlock).toBe(true);
  });

  test("h3.unblock latches the executing core's own event (self-loopback)", () => {
    exec(H3_UNBLOCK);
    expect(cpu.eventRegistered).toBe(true);

    // The latched event arms the next h3.block to fall through, consuming it.
    exec(H3_BLOCK);
    expect(cpu.waiting).toBe(false);
    expect(cpu.eventRegistered).toBe(false);
    expect(cpu.pc).toBe(SCRATCH + 4);

    // Consumed: a second h3.block sleeps.
    exec(H3_BLOCK);
    expect(cpu.waiting).toBe(true);
  });

  test("h3.unblock ends the other core's block sleep", () => {
    chip.core1.waitingOnBlock = true;
    exec(H3_UNBLOCK);
    expect(chip.core1.waiting).toBe(false);
  });

  test('h3.unblock does not end a wfi sleep, but latches the event', () => {
    // core1 parked via wfi (waitingOnBlock=false from beforeEach)
    exec(H3_UNBLOCK);
    expect(chip.core1.waiting).toBe(true);
    expect(chip.core1.eventRegistered).toBe(true);
  });

  test('h3.block falls through on a pending interrupt even with mstatus.mie clear', () => {
    // Same rule as wfi: the sleep/wake condition ignores mstatus.mie.
    forcePendingIrq();
    cpu.csrs[MSTATUS] = 0;
    cpu.interruptsUpdated = false; // exercise the h3.block path, not the pre-fetch check
    exec(H3_BLOCK);
    expect(cpu.waiting).toBe(false);
    expect(cpu.csrs[MCAUSE]).toBe(0); // no trap taken
    expect(cpu.pc).toBe(SCRATCH + 4);
  });

  test('h3.block on a pending unmasked interrupt: trap on the following instruction', () => {
    // Priv spec (wfi, and h3.block builds on the same sleep state): "the
    // interrupt trap will be taken on the following instruction" -- the
    // block instruction retires and mepc is the instruction after it.
    forcePendingIrq();
    cpu.csrs[MTVEC] = TRAPHANDLER;
    cpu.csrs[MSTATUS] = 1 << 3; // mie
    chip.writeUint32(TRAPHANDLER, NOP);
    cpu.interruptsUpdated = false; // exercise the h3.block path, not the pre-fetch check
    exec(H3_BLOCK);
    expect(cpu.waiting).toBe(false);
    expect(cpu.csrs[MCAUSE]).toBe(0); // block itself retires without a trap
    expect(cpu.pc).toBe(SCRATCH + 4);

    cpu.executeInstruction(); // trap taken here, then the handler's NOP runs
    expect(cpu.csrs[MCAUSE] >>> 0).toBe(((1 << 31) | 11) >>> 0); // external interrupt
    expect(cpu.csrs[MEPC] >>> 0).toBe(SCRATCH + 4); // instruction after the block
    expect(cpu.pc >>> 0).toBe(TRAPHANDLER + 4);
  });

  test('wfi on a pending unmasked interrupt: trap on the following instruction', () => {
    forcePendingIrq();
    cpu.csrs[MTVEC] = TRAPHANDLER;
    cpu.csrs[MSTATUS] = 1 << 3; // mie
    chip.writeUint32(TRAPHANDLER, NOP);
    cpu.interruptsUpdated = false; // exercise the wfi path, not the pre-fetch check
    exec(WFI);
    expect(cpu.waiting).toBe(false);
    expect(cpu.pc).toBe(SCRATCH + 4);

    cpu.executeInstruction();
    expect(cpu.csrs[MCAUSE] >>> 0).toBe(((1 << 31) | 11) >>> 0);
    expect(cpu.csrs[MEPC] >>> 0).toBe(SCRATCH + 4);
    expect(cpu.pc >>> 0).toBe(TRAPHANDLER + 4);
  });

  test('wfi sleep sets waitingOnBlock=false so a later unblock cannot end it', () => {
    exec(WFI);
    expect(cpu.waiting).toBe(true);
    expect(cpu.waitingOnBlock).toBe(false);
  });
});
