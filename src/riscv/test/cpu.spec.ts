import { describe, expect, test } from 'vitest';
import { Assembler } from "../Assembler/assembler";
import { RegisterSet } from "../cpu";
import { RP2350 } from "../../rp2350";

describe('Testing RegisterSet class:', () => {
  test('Set x1 to 5', () => {

    const registerSet = new RegisterSet(32);

    registerSet.setRegister(1, 5);

    expect(registerSet.getRegister(1)).toBe(5);

  })
})

describe('Testing R-Type instruction execution:', () => {

  test('Add 3 + 5, place the result in x3', () => {

    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    cpu.registerSet.setRegister(1, 3);
    cpu.registerSet.setRegister(2, 5);

    expect(cpu.registerSet.getRegister(1)).toBe(3);
    expect(cpu.registerSet.getRegister(2)).toBe(5);

    const addInstruction = Assembler.assembleLine('add x3, x1, x2');

    cpu.step(addInstruction.binary);

    expect(cpu.registerSet.getRegister(3)).toBe(8);

  });
})

describe('Testing basic toy programs:', () => {

  test('Simple add, branch, and srl instructions', () => {

    const program = [
      'add tp, ra, sp',
      'beq tp, zero, 0xC',
      'blt tp, ra, 12',
      'add gp, gp, sp',
      'add gp, gp, sp',
      'srl gp, gp, ra',
      'add zero, zero, x1',
      'add zero, zero, x1',
    ]

    const chip = new RP2350();
    const cpu = chip.core0;
    chip.core1.waiting = true;

    const bin = Assembler.assemble(program);
    const prg = new Uint32Array(bin);
    for(let i = 0; i < 20; i++) {
      chip.writeUint32(0x20000000 + (i << 2), prg[i]);
    }
    cpu.pc = 0x20000000;

    cpu.registerSet.setRegister(1, 5);
    cpu.registerSet.setRegister(2, -8);
    cpu.registerSet.setRegister(3, 64);

    for (let i = 0; i < 6; i++) {
      cpu.executeInstruction();
    }

    expect(cpu.registerSet.getRegister(3)).toBe(2);
    expect(cpu.registerSet.getRegister(0)).toBe(0);

  })

})

