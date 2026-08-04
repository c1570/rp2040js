/*
 * Profiler trace-magic tests.
 *
 * The firmware emits a trace event by placing a 0xabcd/0xffff marker
 * immediately after an unconditional jump instruction (JAL, C.J, or C.JAL),
 * followed by a NUL-terminated tag string. The CPU core detects the marker at
 * fetch time and fires chip.onTrace(coreNumber, pc, tag).
 *
 * These tests cover both the 4-byte (JAL) and 2-byte (C.J / C.JAL) paths so
 * the compressed-jump regression that originally broke rp2_test_runner.js
 * (the firmware at 0x10007390 used `c.j`, which bypassed the magic check) is
 * caught if it ever returns.
 */

import { describe, expect, test, vi } from 'vitest';
import { RP2350 } from '../../rp2350';

// SRAM base on RP2350; opcodes.spec.ts uses the same slot for its single-instr
// harness. SRAM is byte-writable via writeUint8, which we need for the tag.
const SCRATCH = 0x20000000;

// Write the marker + tag at `addr`. Layout matches executeJal / cj / cjal:
//   addr+0: 0xabcd  (uint16 LE)
//   addr+2: 0xffff  (uint16 LE)
//   addr+4: tag bytes, NUL-terminated
function writeMagicTag(chip: RP2350, addr: number, tag: string) {
  chip.writeUint16(addr, 0xabcd);
  chip.writeUint16(addr + 2, 0xffff);
  for (let i = 0; i < tag.length; i++) {
    chip.writeUint8(addr + 4 + i, tag.charCodeAt(i));
  }
  chip.writeUint8(addr + 4 + tag.length, 0);
}

describe('RISC-V profiler trace magic', () => {
  test('JAL fires onTrace with the tag and the JAL address', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    // jal x0, +4   ->  0x0040006f   (j 4; imm[20:1] = 2 -> offset 4)
    // The link slot is pc+4, so the magic lands at SCRATCH+4.
    chip.writeUint32(SCRATCH, 0x0040006f);
    writeMagicTag(chip, SCRATCH + 4, 'hello');

    const onTrace = vi.fn();
    chip.onTrace = onTrace;

    cpu.pc = SCRATCH;
    cpu.next_pc = 0;
    cpu.executeInstruction();

    expect(onTrace).toHaveBeenCalledOnce();
    expect(onTrace).toHaveBeenCalledWith(cpu.mhartid, SCRATCH, 'hello');
    // JAL must still jump to pc + imm regardless of the magic.
    expect(cpu.pc).toBe(SCRATCH + 4);
  });

  test('JAL without the marker does not fire onTrace', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    // jal x0, +4 with zeros (not 0xabcd/0xffff) after it.
    chip.writeUint32(SCRATCH, 0x0040006f);
    chip.writeUint32(SCRATCH + 4, 0);

    const onTrace = vi.fn();
    chip.onTrace = onTrace;

    cpu.pc = SCRATCH;
    cpu.next_pc = 0;
    cpu.executeInstruction();

    expect(onTrace).not.toHaveBeenCalled();
  });

  test('C.J fires onTrace — the original rp2_test_runner.js regression', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    // c.j +4  ->  0xa011  (matches opcodes.spec.ts line 636)
    // Compressed jump: the magic sits at pc+2.
    chip.writeUint16(SCRATCH, 0xa011);
    writeMagicTag(chip, SCRATCH + 2, 'tick ');

    const onTrace = vi.fn();
    chip.onTrace = onTrace;

    cpu.pc = SCRATCH;
    cpu.next_pc = 0;
    cpu.executeInstruction();

    expect(onTrace).toHaveBeenCalledOnce();
    expect(onTrace).toHaveBeenCalledWith(cpu.mhartid, SCRATCH, 'tick ');
    expect(cpu.pc).toBe(SCRATCH + 4);
  });

  test('C.JAL fires onTrace and still sets ra = pc+2', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    // c.jal +4  ->  0x2011  (matches opcodes.spec.ts line 584)
    chip.writeUint16(SCRATCH, 0x2011);
    writeMagicTag(chip, SCRATCH + 2, 'call');

    const onTrace = vi.fn();
    chip.onTrace = onTrace;

    cpu.pc = SCRATCH;
    cpu.next_pc = 0;
    cpu.executeInstruction();

    expect(onTrace).toHaveBeenCalledOnce();
    expect(onTrace).toHaveBeenCalledWith(cpu.mhartid, SCRATCH, 'call');
    expect(cpu.getRegisterU(1)).toBe(SCRATCH + 2);
    expect(cpu.pc).toBe(SCRATCH + 4);
  });
});
