import { describe, expect, test } from 'vitest';
import { RP2350 } from '../../rp2350';

describe('Testing the CPU register file:', () => {
  test('Set x1 to 5', () => {
    const cpu = new RP2350().core0;
    cpu.setRegister(1, 5);
    expect(cpu.getRegister(1)).toBe(5);
  });

  test('x0 is always 0', () => {
    const cpu = new RP2350().core0;
    cpu.setRegister(0, 42);
    expect(cpu.getRegister(0)).toBe(0);
  });
});

describe('Testing step() with a raw instruction word:', () => {
  test('add x3, x1, x2  ->  0x002080b3', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    cpu.setRegister(1, 3);
    cpu.setRegister(2, 5);

    // add x3, x1, x2  =  rs2=2, rs1=1, func3=0, rd=3, opcode=0x33  ->  0x002081b3
    cpu.step(0x002081b3);

    expect(cpu.getRegister(3)).toBe(8);
  });
});
