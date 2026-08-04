/*
 * RISC-V opcode regression test.
 *
 * A single, fast test that exercises every opcode the Hazard3
 * emulation in src/riscv/cpu.ts implements.
 * This is primarily an op decoder regression test, not a complete
 * correctness test.
 */

import { describe, expect, test } from 'vitest';
import { RP2350 } from '../../rp2350';
import { CPU } from '../cpu';

// Map of register index -> value; used for both inputs and expected results.
// All values are stored/read as unsigned 32-bit (setRegisterU/getRegisterU),
// so express sign-sensitive expectations as their unsigned hex representation.
type RegMap = Record<number, number>;

describe('RISC-V opcode regression', () => {
  // Fixed SRAM slot each instruction is loaded into. Reusing one address lets
  // us assert on cpu.pc as well as on register state, and avoids the need for
  // any kind of linker/layout logic. SRAM base on RP2350 is 0x20000000.
  const SCRATCH = 0x20000000;
  // Data area for load/store tests, kept well clear of the instruction slot.
  const DATA = 0x20010000;
  // Stack area for c.swsp / cm.push / cm.popret, kept clear of DATA.
  const STACK = 0x20011000;

  // run(): load a single 32-bit instruction word at SCRATCH and execute it
  // once through the full fetch/decode/execute path, then assert.
  //
  //   description   short label (typically the disassembly) used as the
  //                 prefix on every assertion-failure message, so a failing
  //                 run identifies itself unambiguously in the test output
  //   inputRegs     values written into registers before execution
  //   encoding      the 32-bit opcode word
  //   expectedPcInc expected (cpu.pc - SCRATCH) afterwards; 4 for a plain
  //                 32-bit op, 2 for a compressed op, the branch/jump delta
  //                 for control-flow ops
  //   expectedRegs  values asserted on registers after execution
  //
  // The word at SCRATCH+4 is zeroed every time as a defensive measure: JAL
  // probes readUint16(pc+4)/readUint16(pc+6) looking for a profiler-magic
  // marker (0xabcd/0xffff), and we never want stale SRAM to trip that check.
  // Writes to x0 are silently ignored by the register file, as required by
  // the ISA, so {0: ...} in either map is always a no-op / always reads 0.
  function run(
    cpu: CPU,
    description: string,
    inputRegs: RegMap,
    encoding: number,
    expectedPcInc: number,
    expectedRegs: RegMap = {}
  ) {
    const label = `${description}: `;
    for (const idx in inputRegs) {
      cpu.setRegisterU(+idx, inputRegs[idx] >>> 0);
    }
    cpu.chip.writeUint32(SCRATCH, encoding);
    cpu.chip.writeUint32(SCRATCH + 4, 0);
    cpu.pc = SCRATCH;
    cpu.next_pc = 0;
    cpu.executeInstruction();
    for (const idx in expectedRegs) {
      expect(cpu.getRegisterU(+idx), `${label}x${idx}`).toBe(expectedRegs[idx] >>> 0);
    }
    expect(cpu.pc - SCRATCH, `${label}pc`).toBe(expectedPcInc);
  }

  test('executes known opcodes with expected results', () => {
    const chip = new RP2350();
    const cpu = chip.core0;
    // Park core1 so its tick loop and SEV wiring can't interfere.
    chip.core1.waiting = true;

    // lui x5, 0x12345  ->  0x123452b7   ; x5 = imm<<12 = 0x12345000
    run(cpu, 'lui x5, 0x12345', {}, 0x123452b7, 4, { 5: 0x12345000 });

    // xori x6, x7, 0x0f  ->  0x00f3c313  ; 0xff ^ 0x0f = 0xf0
    run(cpu, 'xori x6, x7, 0x0f', { 7: 0xff }, 0x00f3c313, 4, { 6: 0xf0 });

    // xori x6, x7, -1    ->  0xfff3c313  ; imm sign-extends to 0xffffffff
    run(cpu, 'xori x6, x7, -1', { 7: 0x12345678 }, 0xfff3c313, 4, {
      6: 0xedcba987,
    });

    // auipc x5, 0x12345  ->  0x12345297   ; x5 = pc + (0x12345 << 12) = 0x32345000
    run(cpu, 'auipc x5, 0x12345', {}, 0x12345297, 4, { 5: 0x32345000 });

    // jal x1, 0x10       ->  0x010000ef   ; x1 = pc+4, pc += 0x10
    run(cpu, 'jal x1, 0x10', {}, 0x010000ef, 0x10, { 1: 0x20000004 });

    // jalr x1, x5, 0x10  ->  0x010280e7   ; x1 = pc+4, pc = x5 + 0x10
    run(cpu, 'jalr x1, x5, 0x10', { 5: 0x20000100 }, 0x010280e7, 0x110, {
      1: 0x20000004,
      5: 0x20000100,
    });

    // beq x5, x6, 0x10   ->  0x00628863   ; taken when x5 == x6
    run(cpu, 'beq x5, x6, 0x10 (taken)', { 5: 5, 6: 5 }, 0x00628863, 0x10, {});
    run(cpu, 'beq x5, x6, 0x10 (not taken)', { 5: 5, 6: 6 }, 0x00628863, 4, {});

    // bne x5, x6, 0x10   ->  0x00629863   ; taken when x5 != x6
    run(cpu, 'bne x5, x6, 0x10 (taken)', { 5: 5, 6: 6 }, 0x00629863, 0x10, {});
    run(cpu, 'bne x5, x6, 0x10 (not taken)', { 5: 5, 6: 5 }, 0x00629863, 4, {});

    // blt x5, x6, 0x10   ->  0x0062c863   ; signed
    // 0xffffffff is -1 signed: distinguishes blt from bltu with the same inputs
    run(cpu, 'blt x5, x6, 0x10 (taken)', { 5: 0xffffffff, 6: 1 }, 0x0062c863, 0x10, {});
    run(cpu, 'blt x5, x6, 0x10 (not taken)', { 5: 1, 6: 0xffffffff }, 0x0062c863, 4, {});

    // bge x5, x6, 0x10   ->  0x0062d863   ; signed
    run(cpu, 'bge x5, x6, 0x10 (taken)', { 5: 1, 6: 0xffffffff }, 0x0062d863, 0x10, {});
    run(cpu, 'bge x5, x6, 0x10 (not taken)', { 5: 0xffffffff, 6: 1 }, 0x0062d863, 4, {});

    // bltu x5, x6, 0x10  ->  0x0062e863   ; unsigned
    run(cpu, 'bltu x5, x6, 0x10 (taken)', { 5: 1, 6: 0xffffffff }, 0x0062e863, 0x10, {});
    run(cpu, 'bltu x5, x6, 0x10 (not taken)', { 5: 0xffffffff, 6: 1 }, 0x0062e863, 4, {});

    // bgeu x5, x6, 0x10  ->  0x0062f863   ; unsigned
    run(cpu, 'bgeu x5, x6, 0x10 (taken)', { 5: 0xffffffff, 6: 1 }, 0x0062f863, 0x10, {});
    run(cpu, 'bgeu x5, x6, 0x10 (not taken)', { 5: 1, 6: 0xffffffff }, 0x0062f863, 4, {});

    // lb x6, 0(x5)       ->  0x00028303   ; sign-extended byte: 0x80 -> 0xffffff80
    chip.writeUint8(DATA, 0x80);
    run(cpu, 'lb x6, 0(x5)', { 5: DATA }, 0x00028303, 4, { 6: 0xffffff80 });

    // lh x6, 0(x5)       ->  0x00029303   ; sign-extended halfword: 0x8000 -> 0xffff8000
    chip.writeUint16(DATA, 0x8000);
    run(cpu, 'lh x6, 0(x5)', { 5: DATA }, 0x00029303, 4, { 6: 0xffff8000 });

    // lw x6, 0(x5)       ->  0x0002a303   ; full word load: 0xdeadbeef
    chip.writeUint32(DATA, 0xdeadbeef);
    run(cpu, 'lw x6, 0(x5)', { 5: DATA }, 0x0002a303, 4, { 6: 0xdeadbeef });

    // lbu x6, 0(x5)      ->  0x0002c303   ; zero-extended byte: 0x80 -> 0x80
    chip.writeUint8(DATA, 0x80);
    run(cpu, 'lbu x6, 0(x5)', { 5: DATA }, 0x0002c303, 4, { 6: 0x80 });

    // lhu x6, 0(x5)      ->  0x0002d303   ; zero-extended halfword: 0x8000 -> 0x8000
    chip.writeUint16(DATA, 0x8000);
    run(cpu, 'lhu x6, 0(x5)', { 5: DATA }, 0x0002d303, 4, { 6: 0x8000 });

    // sb x6, 0(x5)       ->  0x00628023   ; stores low byte of 0x12345678 -> 0x78
    chip.writeUint32(DATA, 0xdeadbeef);
    run(cpu, 'sb x6, 0(x5)', { 5: DATA, 6: 0x12345678 }, 0x00628023, 4, {});
    expect(chip.readUint8(DATA)).toBe(0x78);

    // sh x6, 0(x5)       ->  0x00629023   ; stores low halfword of 0x12345678 -> 0x5678
    chip.writeUint32(DATA, 0xdeadbeef);
    run(cpu, 'sh x6, 0(x5)', { 5: DATA, 6: 0x12345678 }, 0x00629023, 4, {});
    expect(chip.readUint16(DATA)).toBe(0x5678);

    // sw x6, 0(x5)       ->  0x0062a023   ; stores full word 0x12345678
    chip.writeUint32(DATA, 0xdeadbeef);
    run(cpu, 'sw x6, 0(x5)', { 5: DATA, 6: 0x12345678 }, 0x0062a023, 4, {});
    expect(chip.readUint32(DATA)).toBe(0x12345678);

    // addi x6, x7, 0x0f  ->  0x00f38313   ; 0xff + 0x0f = 0x10e
    run(cpu, 'addi x6, x7, 0x0f', { 7: 0xff }, 0x00f38313, 4, { 6: 0x10e });

    // addi x6, x7, -1    ->  0xfff38313   ; 0xff + (-1) = 0xfe (negative imm)
    run(cpu, 'addi x6, x7, -1', { 7: 0xff }, 0xfff38313, 4, { 6: 0xfe });

    // slli x6, x7, 4     ->  0x00439313   ; 0x1 << 4 = 0x10
    run(cpu, 'slli x6, x7, 4', { 7: 0x1 }, 0x00439313, 4, { 6: 0x10 });

    // slli x6, x7, 31    ->  0x01f39313   ; 0x1 << 31 = 0x80000000 (max shift)
    run(cpu, 'slli x6, x7, 31', { 7: 0x1 }, 0x01f39313, 4, { 6: 0x80000000 });

    // bseti x6, x7, 4    ->  0x28439313   ; 0x1 | (1<<4) = 0x11 (Zbs)
    run(cpu, 'bseti x6, x7, 4', { 7: 0x1 }, 0x28439313, 4, { 6: 0x11 });

    // bclri x6, x7, 4    ->  0x48439313   ; 0xff & ~(1<<4) = 0xef (Zbs)
    run(cpu, 'bclri x6, x7, 4', { 7: 0xff }, 0x48439313, 4, { 6: 0xef });

    // binvi x6, x7, 4    ->  0x68439313   ; 0x0 ^ (1<<4) = 0x10 (Zbs)
    run(cpu, 'binvi x6, x7, 4', { 7: 0x0 }, 0x68439313, 4, { 6: 0x10 });

    // clz x6, x7         ->  0x60039313   ; clz(0x00010000) = 15 (Zbb)
    run(cpu, 'clz x6, x7', { 7: 0x00010000 }, 0x60039313, 4, { 6: 15 });
    // clz x6, x7         ->  0x60039313   ; clz(0) = 32 (Zbb edge case)
    run(cpu, 'clz x6, x7 (zero)', { 7: 0x0 }, 0x60039313, 4, { 6: 32 });

    // ctz x6, x7         ->  0x60139313   ; ctz(0x00010000) = 16 (Zbb)
    run(cpu, 'ctz x6, x7', { 7: 0x00010000 }, 0x60139313, 4, { 6: 16 });
    // ctz x6, x7         ->  0x60139313   ; ctz(0) = 32 (Zbb edge case)
    run(cpu, 'ctz x6, x7 (zero)', { 7: 0x0 }, 0x60139313, 4, { 6: 32 });

    // cpop x6, x7        ->  0x60239313   ; cpop(0xff) = 8 (Zbb)
    run(cpu, 'cpop x6, x7', { 7: 0xff }, 0x60239313, 4, { 6: 8 });

    // sext.b x6, x7      ->  0x60439313   ; 0x80 sign-extended -> 0xffffff80 (Zbb)
    run(cpu, 'sext.b x6, x7', { 7: 0x80 }, 0x60439313, 4, { 6: 0xffffff80 });

    // sext.h x6, x7      ->  0x60539313   ; 0x8000 sign-extended -> 0xffff8000 (Zbb)
    run(cpu, 'sext.h x6, x7', { 7: 0x8000 }, 0x60539313, 4, { 6: 0xffff8000 });

    // slti x6, x7, 1     ->  0x0013a313   ; signed: -1 < 1 -> 1
    run(cpu, 'slti x6, x7, 1 (true)', { 7: 0xffffffff }, 0x0013a313, 4, { 6: 1 });
    run(cpu, 'slti x6, x7, 1 (false)', { 7: 0x2 }, 0x0013a313, 4, { 6: 0 });

    // sltiu x6, x7, 1    ->  0x0013b313   ; unsigned: 0xffffffff < 1 -> 0
    run(cpu, 'sltiu x6, x7, 1 (false)', { 7: 0xffffffff }, 0x0013b313, 4, { 6: 0 });
    run(cpu, 'sltiu x6, x7, 1 (true)', { 7: 0x0 }, 0x0013b313, 4, { 6: 1 });

    // srli x6, x7, 4     ->  0x0043d313   ; 0xff >> 4 = 0x0f
    run(cpu, 'srli x6, x7, 4', { 7: 0xff }, 0x0043d313, 4, { 6: 0x0f });

    // srli x6, x7, 31    ->  0x01f3d313   ; 0x80000000 >> 31 = 1 (max shift)
    run(cpu, 'srli x6, x7, 31', { 7: 0x80000000 }, 0x01f3d313, 4, { 6: 1 });

    // srai x6, x7, 4     ->  0x4043d313   ; 0x80000000 >>> 4 = 0xf8000000 (arithmetic)
    run(cpu, 'srai x6, x7, 4', { 7: 0x80000000 }, 0x4043d313, 4, { 6: 0xf8000000 });

    // bexti x6, x7, 4    ->  0x4843d313   ; (0x10 >> 4) & 1 = 1 (Zbs single-bit extract)
    run(cpu, 'bexti x6, x7, 4', { 7: 0x10 }, 0x4843d313, 4, { 6: 1 });

    // rori x6, x7, 4     ->  0x6043d313   ; 0x12345678 ror 4 = 0x81234567 (Zbs rotate)
    run(cpu, 'rori x6, x7, 4', { 7: 0x12345678 }, 0x6043d313, 4, { 6: 0x81234567 });

    // rev8 x6, x7        ->  0x6983d313   ; byte-reverse: 0x12345678 -> 0x78563412 (Zbb)
    run(cpu, 'rev8 x6, x7', { 7: 0x12345678 }, 0x6983d313, 4, { 6: 0x78563412 });

    // orc.b x6, x7       ->  0x2873d313   ; broadcast bit 7 of each byte (Zbb)
    run(cpu, 'orc.b x6, x7', { 7: 0x807f0080 }, 0x2873d313, 4, { 6: 0xff0000ff });

    // brev8 x6, x7       ->  0x6873d313   ; reverse bits within each byte (Zbkb)
    run(cpu, 'brev8 x6, x7', { 7: 0x01020408 }, 0x6873d313, 4, { 6: 0x80402010 });

    // zip x6, x7         ->  0x08f39313   ; interleave high/low halves (Zbkb)
    // 0xFFFF0000 -> even bits from high half=1, odd bits from low half=0 -> 0x55555555
    run(cpu, 'zip x6, x7', { 7: 0xffff0000 }, 0x08f39313, 4, { 6: 0x55555555 });

    // unzip x6, x7       ->  0x08f3d313   ; deinterleave odd/even bits (Zbkb)
    // 0xAAAAAAAA -> odd bits to low half (0xFFFF), even bits to high half (0x0000)
    run(cpu, 'unzip x6, x7', { 7: 0xaaaaaaaa }, 0x08f3d313, 4, { 6: 0x0000ffff });

    // ori x6, x7, 0x0f   ->  0x00f3e313   ; 0xf0 | 0x0f = 0xff
    run(cpu, 'ori x6, x7, 0x0f', { 7: 0xf0 }, 0x00f3e313, 4, { 6: 0xff });

    // andi x6, x7, 0x0f  ->  0x00f3f313   ; 0xff & 0x0f = 0x0f
    run(cpu, 'andi x6, x7, 0x0f', { 7: 0xff }, 0x00f3f313, 4, { 6: 0x0f });

    // add x6, x7, x8     ->  0x00838333   ; 3 + 5 = 8
    run(cpu, 'add x6, x7, x8', { 7: 3, 8: 5 }, 0x00838333, 4, { 6: 8 });

    // sub x6, x7, x8     ->  0x40838333   ; 5 - 3 = 2
    run(cpu, 'sub x6, x7, x8', { 7: 5, 8: 3 }, 0x40838333, 4, { 6: 2 });

    // mul x6, x7, x8     ->  0x02838333   ; 6 * 7 = 42 (RV32M)
    run(cpu, 'mul x6, x7, x8', { 7: 6, 8: 7 }, 0x02838333, 4, { 6: 42 });
    // Large operands that exceed double precision — Math.imul gives correct low 32 bits
    run(cpu, 'mul x6, x7, x8 (precision)', { 7: 0x08000001, 8: 0x08000001 }, 0x02838333, 4, {
      6: 0x10000001,
    });

    // sll x6, x7, x8     ->  0x00839333   ; 0x1 << 4 = 0x10
    run(cpu, 'sll x6, x7, x8', { 7: 0x1, 8: 4 }, 0x00839333, 4, { 6: 0x10 });

    // mulh x6, x7, x8    ->  0x02839333   ; signed*signed high: 0x10000*0x10000=0x100000000 -> high=1 (RV32M)
    run(cpu, 'mulh x6, x7, x8', { 7: 0x10000, 8: 0x10000 }, 0x02839333, 4, { 6: 1 });

    // bset x6, x7, x8    ->  0x28839333   ; 0x1 | (1<<4) = 0x11 (Zbs)
    run(cpu, 'bset x6, x7, x8', { 7: 0x1, 8: 4 }, 0x28839333, 4, { 6: 0x11 });

    // bclr x6, x7, x8    ->  0x48839333   ; 0xff & ~(1<<4) = 0xef (Zbs)
    run(cpu, 'bclr x6, x7, x8', { 7: 0xff, 8: 4 }, 0x48839333, 4, { 6: 0xef });

    // binv x6, x7, x8    ->  0x68839333   ; 0xff ^ (1<<4) = 0xef (Zbs)
    run(cpu, 'binv x6, x7, x8', { 7: 0xff, 8: 4 }, 0x68839333, 4, { 6: 0xef });

    // rol x6, x7, x8     ->  0x60839333   ; 0x12345678 rot-left 4 = 0x23456781 (Zbb)
    run(cpu, 'rol x6, x7, x8', { 7: 0x12345678, 8: 4 }, 0x60839333, 4, { 6: 0x23456781 });

    // slt x6, x7, x8     ->  0x0083a333   ; signed: -1 < 1 -> 1
    run(cpu, 'slt x6, x7, x8', { 7: 0xffffffff, 8: 1 }, 0x0083a333, 4, { 6: 1 });

    // sh1add x6, x7, x8  ->  0x2083a333   ; (0x1 << 1) + 0x3 = 5 (Zbb)
    run(cpu, 'sh1add x6, x7, x8', { 7: 0x1, 8: 0x3 }, 0x2083a333, 4, { 6: 5 });

    // mulhsu x6, x7, x8  ->  0x0283a333   ; signed*unsigned: 0x10000*0x10000 high=1 (RV32M)
    run(cpu, 'mulhsu x6, x7, x8', { 7: 0x10000, 8: 0x10000 }, 0x0283a333, 4, { 6: 1 });

    // sltu x6, x7, x8    ->  0x0083b333   ; unsigned: 0xffffffff < 1 -> 0
    run(cpu, 'sltu x6, x7, x8', { 7: 0xffffffff, 8: 1 }, 0x0083b333, 4, { 6: 0 });

    // mulhu x6, x7, x8   ->  0x0283b333   ; 0x10000*0x10000=0x100000000 -> high=1 (RV32M)
    run(cpu, 'mulhu x6, x7, x8', { 7: 0x10000, 8: 0x10000 }, 0x0283b333, 4, { 6: 1 });

    // xor x6, x7, x8     ->  0x0083c333   ; 0xff ^ 0x0f = 0xf0
    run(cpu, 'xor x6, x7, x8', { 7: 0xff, 8: 0x0f }, 0x0083c333, 4, { 6: 0xf0 });

    // div x6, x7, x8     ->  0x0283c333   ; 100 / 7 = 14 (RV32M)
    run(cpu, 'div x6, x7, x8', { 7: 100, 8: 7 }, 0x0283c333, 4, { 6: 14 });
    // div x6, x7, x8     ->  0x0283c333   ; div-by-0 -> 0xffffffff
    run(cpu, 'div x6, x7, x8 (div-by-0)', { 7: 100, 8: 0 }, 0x0283c333, 4, {
      6: 0xffffffff,
    });
    // div x6, x7, x8     ->  0x0283c333   ; overflow: 0x80000000 / -1 -> 0x80000000
    run(cpu, 'div x6, x7, x8 (overflow)', { 7: 0x80000000, 8: 0xffffffff }, 0x0283c333, 4, {
      6: 0x80000000,
    });

    // sh2add x6, x7, x8  ->  0x2083c333   ; (0x1 << 2) + 0x3 = 7 (Zbb)
    run(cpu, 'sh2add x6, x7, x8', { 7: 0x1, 8: 0x3 }, 0x2083c333, 4, { 6: 7 });

    // pack x6, x7, x8    ->  0x0883c333   ; (0x1234 & 0xffff)|((0xabcd & 0xffff)<<16) = 0xabcd1234 (Zbkb)
    run(cpu, 'pack x6, x7, x8', { 7: 0x1234, 8: 0xabcd }, 0x0883c333, 4, {
      6: 0xabcd1234,
    });

    // min x6, x7, x8     ->  0x0a83c333   ; signed: -1 < 1 -> 0xffffffff (Zbb)
    run(cpu, 'min x6, x7, x8', { 7: 0xffffffff, 8: 1 }, 0x0a83c333, 4, {
      6: 0xffffffff,
    });

    // xnor x6, x7, x8    ->  0x4083c333   ; ~(0xff ^ 0x0f) = ~0xf0 = 0xffffff0f (Zbb)
    run(cpu, 'xnor x6, x7, x8', { 7: 0xff, 8: 0x0f }, 0x4083c333, 4, {
      6: 0xffffff0f,
    });

    // srl x6, x7, x8     ->  0x0083d333   ; 0xff >> 4 = 0x0f
    run(cpu, 'srl x6, x7, x8', { 7: 0xff, 8: 4 }, 0x0083d333, 4, { 6: 0x0f });

    // sra x6, x7, x8     ->  0x4083d333   ; 0x80000000 >>> 4 = 0xf8000000 (arithmetic)
    run(cpu, 'sra x6, x7, x8', { 7: 0x80000000, 8: 4 }, 0x4083d333, 4, {
      6: 0xf8000000,
    });

    // ror x6, x7, x8     ->  0x6083d333   ; 0x12345678 rot-right 4 = 0x81234567 (Zbb)
    run(cpu, 'ror x6, x7, x8', { 7: 0x12345678, 8: 4 }, 0x6083d333, 4, { 6: 0x81234567 });

    // bext x6, x7, x8    ->  0x4883d333   ; (0x10 >> 4) & 1 = 1 (Zbs single-bit extract)
    run(cpu, 'bext x6, x7, x8', { 7: 0x10, 8: 4 }, 0x4883d333, 4, { 6: 1 });

    // divu x6, x7, x8    ->  0x0283d333   ; unsigned 100 / 7 = 14 (RV32M)
    run(cpu, 'divu x6, x7, x8', { 7: 100, 8: 7 }, 0x0283d333, 4, { 6: 14 });
    // divu x6, x7, x8    ->  0x0283d333   ; div-by-0 -> 0xffffffff
    run(cpu, 'divu x6, x7, x8 (div-by-0)', { 7: 100, 8: 0 }, 0x0283d333, 4, {
      6: 0xffffffff,
    });

    // minu x6, x7, x8    ->  0x0a83d333   ; unsigned: 1 < 0xffffffff -> 1 (Zbb)
    run(cpu, 'minu x6, x7, x8', { 7: 0xffffffff, 8: 1 }, 0x0a83d333, 4, { 6: 1 });

    // or x6, x7, x8      ->  0x0083e333   ; 0xf0 | 0x0f = 0xff
    run(cpu, 'or x6, x7, x8', { 7: 0xf0, 8: 0x0f }, 0x0083e333, 4, { 6: 0xff });

    // rem x6, x7, x8     ->  0x0283e333   ; signed 100 % 7 = 2 (RV32M)
    run(cpu, 'rem x6, x7, x8', { 7: 100, 8: 7 }, 0x0283e333, 4, { 6: 2 });
    // rem x6, x7, x8     ->  0x0283e333   ; rem-by-0 -> dividend (100)
    run(cpu, 'rem x6, x7, x8 (rem-by-0)', { 7: 100, 8: 0 }, 0x0283e333, 4, { 6: 100 });

    // max x6, x7, x8     ->  0x0a83e333   ; signed: 1 > -1 -> 1 (Zbb)
    run(cpu, 'max x6, x7, x8', { 7: 0xffffffff, 8: 1 }, 0x0a83e333, 4, { 6: 1 });

    // orn x6, x7, x8     ->  0x4083e333   ; 0xf0 | ~0x0f = 0xfffffff0 (Zbb)
    run(cpu, 'orn x6, x7, x8', { 7: 0xf0, 8: 0x0f }, 0x4083e333, 4, {
      6: 0xfffffff0,
    });

    // sh3add x6, x7, x8  ->  0x2083e333   ; (0x1 << 3) + 0x3 = 0xb (Zbb)
    run(cpu, 'sh3add x6, x7, x8', { 7: 0x1, 8: 0x3 }, 0x2083e333, 4, { 6: 0xb });

    // and x6, x7, x8     ->  0x0083f333   ; 0xff & 0x0f = 0x0f
    run(cpu, 'and x6, x7, x8', { 7: 0xff, 8: 0x0f }, 0x0083f333, 4, { 6: 0x0f });

    // andn x6, x7, x8    ->  0x4083f333   ; 0xff & ~0x0f = 0xf0 (Zbb)
    run(cpu, 'andn x6, x7, x8', { 7: 0xff, 8: 0x0f }, 0x4083f333, 4, { 6: 0xf0 });

    // packh x6, x7, x8   ->  0x0883f333   ; (0x12 & 0xff)|((0x34 & 0xff)<<8) = 0x3412 (Zbkb)
    run(cpu, 'packh x6, x7, x8', { 7: 0x12, 8: 0x34 }, 0x0883f333, 4, { 6: 0x3412 });

    // maxu x6, x7, x8    ->  0x0a83f333   ; unsigned: 0xffffffff > 1 -> 0xffffffff (Zbb)
    run(cpu, 'maxu x6, x7, x8', { 7: 0xffffffff, 8: 1 }, 0x0a83f333, 4, {
      6: 0xffffffff,
    });

    // remu x6, x7, x8    ->  0x0283f333   ; unsigned 100 % 7 = 2 (RV32M)
    run(cpu, 'remu x6, x7, x8', { 7: 100, 8: 7 }, 0x0283f333, 4, { 6: 2 });
    // remu x6, x7, x8    ->  0x0283f333   ; rem-by-0 -> dividend
    run(cpu, 'remu x6, x7, x8 (rem-by-0)', { 7: 100, 8: 0 }, 0x0283f333, 4, { 6: 100 });

    // AMO instructions (opcode 0x2f, func3 0x2) atomically read+write mem[x7].
    // amoswap.w x6, x8, (x7) -> 0x0883a32f ; rd <- mem, mem <- x8
    chip.writeUint32(DATA, 0xdead);
    run(cpu, 'amoswap.w x6, x8, (x7)', { 7: DATA, 8: 0xbeef }, 0x0883a32f, 4, { 6: 0xdead });
    expect(chip.readUint32(DATA)).toBe(0xbeef);

    // amoor.w x6, x8, (x7)   -> 0x4083a32f ; rd <- mem, mem <- mem | x8
    chip.writeUint32(DATA, 0xf0);
    run(cpu, 'amoor.w x6, x8, (x7)', { 7: DATA, 8: 0x0f }, 0x4083a32f, 4, { 6: 0xf0 });
    expect(chip.readUint32(DATA)).toBe(0xff);

    // amoand.w x6, x8, (x7)  -> 0x6083a32f ; rd <- mem, mem <- mem & x8
    chip.writeUint32(DATA, 0xff);
    run(cpu, 'amoand.w x6, x8, (x7)', { 7: DATA, 8: 0x0f }, 0x6083a32f, 4, { 6: 0xff });
    expect(chip.readUint32(DATA)).toBe(0x0f);

    // amoadd.w x6, x8, (x7)  -> 0x0083a32f ; rd <- mem, mem <- mem + x8
    chip.writeUint32(DATA, 10);
    run(cpu, 'amoadd.w x6, x8, (x7)', { 7: DATA, 8: 20 }, 0x0083a32f, 4, { 6: 10 });
    expect(chip.readUint32(DATA)).toBe(30);

    // amoxor.w x6, x8, (x7)  -> 0x2083a32f ; rd <- mem, mem <- mem ^ x8
    chip.writeUint32(DATA, 0xff);
    run(cpu, 'amoxor.w x6, x8, (x7)', { 7: DATA, 8: 0x0f }, 0x2083a32f, 4, { 6: 0xff });
    expect(chip.readUint32(DATA)).toBe(0xf0);

    // amomin.w x6, x8, (x7)  -> 0x8083a32f ; rd <- mem, mem <- min(mem, x8) signed
    chip.writeUint32(DATA, 0xffffffff);
    run(cpu, 'amomin.w x6, x8, (x7)', { 7: DATA, 8: 1 }, 0x8083a32f, 4, { 6: 0xffffffff });
    expect(chip.readUint32(DATA)).toBe(0xffffffff);

    // amomax.w x6, x8, (x7)  -> 0xa083a32f ; rd <- mem, mem <- max(mem, x8) signed
    chip.writeUint32(DATA, 0xffffffff);
    run(cpu, 'amomax.w x6, x8, (x7)', { 7: DATA, 8: 1 }, 0xa083a32f, 4, { 6: 0xffffffff });
    expect(chip.readUint32(DATA)).toBe(1);

    // amominu.w x6, x8, (x7) -> 0xc083a32f ; rd <- mem, mem <- min(mem, x8) unsigned
    chip.writeUint32(DATA, 0xffffffff);
    run(cpu, 'amominu.w x6, x8, (x7)', { 7: DATA, 8: 1 }, 0xc083a32f, 4, { 6: 0xffffffff });
    expect(chip.readUint32(DATA)).toBe(1);

    // amomaxu.w x6, x8, (x7) -> 0xe083a32f ; rd <- mem, mem <- max(mem, x8) unsigned
    chip.writeUint32(DATA, 0xffffffff);
    run(cpu, 'amomaxu.w x6, x8, (x7)', { 7: DATA, 8: 1 }, 0xe083a32f, 4, { 6: 0xffffffff });
    expect(chip.readUint32(DATA)).toBe(0xffffffff);

    // lr.w x6, (x7)          -> 0x1003a32f ; load-reserved: rd <- mem, set reservation
    chip.writeUint32(DATA, 0xdeadbeef);
    run(cpu, 'lr.w x6, (x7)', { 7: DATA }, 0x1003a32f, 4, { 6: 0xdeadbeef });
    expect(cpu.lr_addr).toBe(DATA & ~0xf);

    // sc.w x6, x8, (x7)      -> 0x1883a32f ; store-conditional: succeeds (rd=0) if reservation valid
    run(cpu, 'sc.w x6, x8, (x7)', { 7: DATA, 8: 0xcafef00d }, 0x1883a32f, 4, { 6: 0 });
    expect(chip.readUint32(DATA)).toBe(0xcafef00d);
    expect(cpu.lr_addr).toBe(-1);

    // sc.w without prior lr.w -> fails (rd=1), no store
    run(cpu, 'sc.w x6, x8, (x7) (no lr)', { 7: DATA, 8: 0x11111111 }, 0x1883a32f, 4, { 6: 1 });
    expect(chip.readUint32(DATA)).toBe(0xcafef00d);

    // sc.w to same 16-byte granule but different word succeeds
    chip.writeUint32(DATA, 0x2222);
    run(cpu, 'lr.w x6, (x7)', { 7: DATA }, 0x1003a32f, 4, { 6: 0x2222 });
    // sc.w to DATA+4 (same granule since DATA is 16-aligned) should succeed
    run(cpu, 'sc.w x6, x8, (x7)', { 7: DATA + 4, 8: 0x3333 }, 0x1883a32f, 4, { 6: 0 });
    expect(chip.readUint32(DATA + 4)).toBe(0x3333);
    expect(cpu.lr_addr).toBe(-1);

    // Cross-core invalidation: core1 lr.w to same granule invalidates core0's reservation
    chip.writeUint32(DATA, 0xaaaa);
    run(cpu, 'lr.w x6, (x7)', { 7: DATA }, 0x1003a32f, 4, { 6: 0xaaaa });
    expect(cpu.lr_addr).toBe(DATA & ~0xf);
    // core1 does lr.w to the same granule
    chip.core1.waiting = false;
    chip.core1.setRegister(7, DATA);
    chip.writeUint32(SCRATCH, 0x1003a32f); // lr.w x0, (x7)
    chip.core1.pc = SCRATCH;
    chip.core1.executeInstruction();
    chip.core1.waiting = true;
    expect(cpu.lr_addr).toBe(-1); // core0's reservation invalidated
    run(cpu, 'sc.w x6, x8, (x7) (invalidated)', { 7: DATA, 8: 0xcccc }, 0x1883a32f, 4, { 6: 1 });
    expect(chip.readUint32(DATA)).toBe(0xaaaa);

    // MISC-MEM (opcode 0x0f): fence / fence.i are no-ops in the emulator but
    // must execute without throwing. No register or memory side effects.
    // fence               -> 0x0000000f
    run(cpu, 'fence', {}, 0x0000000f, 4, {});
    // fence.i             -> 0x0000100f
    run(cpu, 'fence.i', {}, 0x0000100f, 4, {});

    // SYSTEM (opcode 0x73): CSR ops round-trip through mscratch (0x340).
    // csrrw x6, x7, 0x340  -> 0x34039373   ; rd <- csr, csr <- x7
    cpu.csrs[0x340] = 0xaaa;
    run(cpu, 'csrrw x6, x7, mscratch', { 7: 0xbbb }, 0x34039373, 4, { 6: 0xaaa });
    expect(cpu.csrs[0x340]).toBe(0xbbb);

    // csrrs x6, x7, 0x340  -> 0x3403a373   ; rd <- csr, csr <- csr | x7
    cpu.csrs[0x340] = 0xf0;
    run(cpu, 'csrrs x6, x7, mscratch', { 7: 0x0f }, 0x3403a373, 4, { 6: 0xf0 });
    expect(cpu.csrs[0x340]).toBe(0xff);

    // csrrc x6, x7, 0x340  -> 0x3403b373   ; rd <- csr, csr <- csr & ~x7
    cpu.csrs[0x340] = 0xff;
    run(cpu, 'csrrc x6, x7, mscratch', { 7: 0x0f }, 0x3403b373, 4, { 6: 0xff });
    expect(cpu.csrs[0x340]).toBe(0xf0);

    // CSR-immediate variants: 5-bit imm lives in the rs1 field (bits[19:15]).
    // csrrwi x6, 0x05, 0x340 -> 0x3402d373  ; rd <- csr, csr <- imm
    cpu.csrs[0x340] = 0xaaa;
    run(cpu, 'csrrwi x6, 0x05, mscratch', {}, 0x3402d373, 4, { 6: 0xaaa });
    expect(cpu.csrs[0x340]).toBe(0x05);

    // csrrsi x6, 0x0f, 0x340 -> 0x3407e373  ; rd <- csr, csr <- csr | imm
    cpu.csrs[0x340] = 0xf0;
    run(cpu, 'csrrsi x6, 0x0f, mscratch', {}, 0x3407e373, 4, { 6: 0xf0 });
    expect(cpu.csrs[0x340]).toBe(0xff);

    // csrrci x6, 0x0f, 0x340 -> 0x3407f373  ; rd <- csr, csr <- csr & ~imm
    cpu.csrs[0x340] = 0xff;
    run(cpu, 'csrrci x6, 0x0f, mscratch', {}, 0x3407f373, 4, { 6: 0xff });
    expect(cpu.csrs[0x340]).toBe(0xf0);

    // mret / ecall / ebreak transfer control via the trap machinery, so we
    // set up mtvec/mepc/mstatus in CSRs first and assert the target PC via
    // the expectedPcInc delta.
    const TRAPHANDLER = 0x20020000;

    // mret                -> 0x30200073    ; pc <- mepc, restore MSTATUS.MIE
    cpu.csrs[0x341] = TRAPHANDLER; // mepc
    cpu.csrs[0x300] = 0x80; // mstatus: MPIE=1, MIE=0
    run(cpu, 'mret', {}, 0x30200073, TRAPHANDLER - SCRATCH, {});

    // ecall               -> 0x00000073    ; M-mode trap, mcause=0xb
    cpu.csrs[0x305] = TRAPHANDLER; // mtvec
    run(cpu, 'ecall', {}, 0x00000073, TRAPHANDLER - SCRATCH, {});
    expect(cpu.csrs[0x342]).toBe(0xb); // mcause
    expect(cpu.csrs[0x341]).toBe(SCRATCH >>> 0); // mepc = faulting pc

    // ebreak              -> 0x00100073    ; trap, mcause=3
    run(cpu, 'ebreak', {}, 0x00100073, TRAPHANDLER - SCRATCH, {});
    expect(cpu.csrs[0x342]).toBe(3); // mcause

    // wfi                 -> 0x10500073    ; halt until interrupt
    cpu.waiting = false;
    run(cpu, 'wfi', {}, 0x10500073, 4, {});
    expect(cpu.waiting).toBe(true);
    cpu.waiting = false; // reset for subsequent tests

    // CUSTOM0 (opcode 0x0b): Hazard3 bit-field extract with mask.
    // h3.bextm: rd = (rs1 >> rs2) & ((2<<size)-1). size=2 -> 3-bit mask.
    // h3.bextm x6, x7, x8, size=2 -> 0x0883830b   ; (0xff >> 4) & 0x7 = 7
    run(cpu, 'h3.bextm x6, x7, x8, size=2', { 7: 0xff, 8: 4 }, 0x0883830b, 4, { 6: 7 });

    // h3.bextmi: same but rs2 field is an immediate shift amount.
    // h3.bextmi x6, x4, 4, size=2 -> 0x0882030b   ; (0xff >> 4) & 0x7 = 7
    run(cpu, 'h3.bextmi x6, x4, 4, size=2', { 4: 0xff }, 0x0882030b, 4, { 6: 7 });

    // RV32C compressed instructions (16-bit). fetchInstruction() reads 16
    // bits; if the low two bits are != 0b11 it decompresses to 32 bits. The
    // run() helper writes a 32-bit word but only the low 16 bits matter here,
    // and inst_length becomes 2 so PC advances by 2.
    // c.addi4spn x9, 4     -> 0x0044        ; decompresses to addi x9, x2, 4
    run(cpu, 'c.addi4spn x9, 4', { 2: 0x100 }, 0x0044, 2, { 9: 0x104 });

    // c.lw x9, 4(x9)       -> 0x40c4        ; decompresses to lw x9, 4(x9)
    chip.writeUint32(DATA + 4, 0xdeadbeef);
    run(cpu, 'c.lw x9, 4(x9)', { 9: DATA }, 0x40c4, 2, { 9: 0xdeadbeef });

    // c.sw x9, 4(x9)       -> 0xc0c4        ; decompresses to sw x9, 4(x9)
    chip.writeUint32(DATA + 4, 0);
    run(cpu, 'c.sw x9, 4(x9)', { 9: DATA }, 0xc0c4, 2, {});
    expect(chip.readUint32(DATA + 4)).toBe(DATA);

    // c.lhu x9, 0(x9)      -> 0x8484        ; Zcb: decompresses to lhu x9, 0(x9)
    chip.writeUint32(DATA, 0x8000);
    run(cpu, 'c.lhu x9, 0(x9)', { 9: DATA }, 0x8484, 2, { 9: 0x8000 });

    // c.lbu x9, 0(x9)      -> 0x8084        ; Zcb: decompresses to lbu x9, 0(x9)
    chip.writeUint32(DATA, 0x80);
    run(cpu, 'c.lbu x9, 0(x9)', { 9: DATA }, 0x8084, 2, { 9: 0x80 });

    // c.lh x8, 0(x9)       -> 0x84c0        ; Zcb: sign-extended halfword: 0x8000 -> 0xffff8000
    chip.writeUint32(DATA, 0x8000);
    run(cpu, 'c.lh x8, 0(x9)', { 9: DATA }, 0x84c0, 2, { 8: 0xffff8000 });

    // c.sb x8, 0(x9)       -> 0x8880        ; Zcb: stores low byte of 0x42
    chip.writeUint32(DATA, 0xdeadbeef);
    run(cpu, 'c.sb x8, 0(x9)', { 8: 0x42, 9: DATA }, 0x8880, 2, {});
    expect(chip.readUint8(DATA)).toBe(0x42);

    // c.sh x9, 0(x9)       -> 0x8c84        ; Zcb: stores low halfword of x9
    chip.writeUint32(DATA, 0xdeadbeef);
    run(cpu, 'c.sh x9, 0(x9)', { 9: DATA }, 0x8c84, 2, {});
    expect(chip.readUint16(DATA)).toBe(DATA & 0xffff);

    // c.addi x5, 3         -> 0x028d        ; decompresses to addi x5, x5, 3
    run(cpu, 'c.addi x5, 3', { 5: 0x10 }, 0x028d, 2, { 5: 0x13 });

    // c.jal x1, 4          -> 0x2011        ; decompresses to jal x1, 4 (ra = pc+2)
    run(cpu, 'c.jal x1, 4', {}, 0x2011, 4, { 1: 0x20000002 });

    // c.li x5, 3           -> 0x428d        ; decompresses to addi x5, x0, 3
    run(cpu, 'c.li x5, 3', {}, 0x428d, 2, { 5: 3 });

    // c.addi16sp x2, 16    -> 0x6141        ; decompresses to addi x2, x2, 16
    run(cpu, 'c.addi16sp x2, 16', { 2: 0x100 }, 0x6141, 2, { 2: 0x110 });

    // c.lui x5, 2          -> 0x6289        ; decompresses to lui x5, 2 -> x5 = 2<<12
    run(cpu, 'c.lui x5, 2', {}, 0x6289, 2, { 5: 0x2000 });

    // c.srli x9, 4         -> 0x8091        ; decompresses to srli x9, x9, 4
    run(cpu, 'c.srli x9, 4', { 9: 0xff }, 0x8091, 2, { 9: 0x0f });

    // c.srai x9, 4         -> 0x8491        ; decompresses to srai x9, x9, 4 (arithmetic)
    run(cpu, 'c.srai x9, 4', { 9: 0x80000000 }, 0x8491, 2, { 9: 0xf8000000 });

    // c.andi x9, 0x0f      -> 0x88bd        ; decompresses to andi x9, x9, 0x0f
    run(cpu, 'c.andi x9, 0x0f', { 9: 0xff }, 0x88bd, 2, { 9: 0x0f });

    // The c.sub/c.xor/c.or/c.and/c.not group shares funct3=100, cb_funct2=11,
    // distinguished by funct6[3] (bit 12) and funct2 (bits[6:5]).
    // c.sub x9, x10        -> 0x8c89        ; decompresses to sub x9, x9, x10
    run(cpu, 'c.sub x9, x10', { 9: 5, 10: 3 }, 0x8c89, 2, { 9: 2 });

    // c.xor x9, x10        -> 0x8ca9        ; decompresses to xor x9, x9, x10
    run(cpu, 'c.xor x9, x10', { 9: 0xff, 10: 0x0f }, 0x8ca9, 2, { 9: 0xf0 });

    // c.or x9, x10         -> 0x8cc9        ; decompresses to or x9, x9, x10
    run(cpu, 'c.or x9, x10', { 9: 0xf0, 10: 0x0f }, 0x8cc9, 2, { 9: 0xff });

    // c.and x9, x10        -> 0x8ce9        ; decompresses to and x9, x9, x10
    run(cpu, 'c.and x9, x10', { 9: 0xff, 10: 0x0f }, 0x8ce9, 2, { 9: 0x0f });

    // c.not x8 (Zcb)       -> 0x9c75        ; decompresses to xori x8, x8, -1
    run(cpu, 'c.not x8', { 8: 0x0f }, 0x9c75, 2, { 8: 0xfffffff0 });

    // c.mul x8, x10 (Zcb)  -> 0x9c49        ; decompresses to mul x8, x8, x10
    run(cpu, 'c.mul x8, x10', { 8: 6, 10: 7 }, 0x9c49, 2, { 8: 42 });

    // c.zext.b x8 (Zcb)    -> 0x9c61        ; decompresses to andi x8, x8, 0xff
    run(cpu, 'c.zext.b x8', { 8: 0x12345678 }, 0x9c61, 2, { 8: 0x78 });

    // c.sext.b x8 (Zcb)    -> 0x9c65        ; decompresses to sext.b x8, x8
    run(cpu, 'c.sext.b x8', { 8: 0x80 }, 0x9c65, 2, { 8: 0xffffff80 });

    // c.zext.h x8 (Zcb)    -> 0x9c69        ; decompresses to zext.h x8, x8
    run(cpu, 'c.zext.h x8', { 8: 0x12345678 }, 0x9c69, 2, { 8: 0x5678 });

    // c.sext.h x8 (Zcb)    -> 0x9c6d        ; decompresses to sext.h x8, x8
    run(cpu, 'c.sext.h x8', { 8: 0x8000 }, 0x9c6d, 2, { 8: 0xffff8000 });

    // c.j 4                -> 0xa011        ; decompresses to jal x0, 4 (jump, no link)
    run(cpu, 'c.j 4', {}, 0xa011, 4, {});

    // c.beqz x9, 8         -> 0xc481        ; decompresses to beq x9, x0, 8
    run(cpu, 'c.beqz x9, 8 (taken)', { 9: 0 }, 0xc481, 8, {});
    run(cpu, 'c.beqz x9, 8 (not taken)', { 9: 1 }, 0xc481, 2, {});

    // c.bnez x9, 8         -> 0xe481        ; decompresses to bne x9, x0, 8
    run(cpu, 'c.bnez x9, 8 (taken)', { 9: 1 }, 0xe481, 8, {});
    run(cpu, 'c.bnez x9, 8 (not taken)', { 9: 0 }, 0xe481, 2, {});

    // Quadrant 2 (opcode=10) compressed instructions use the full register set.
    // c.slli x5, 4         -> 0x0292        ; decompresses to slli x5, x5, 4
    run(cpu, 'c.slli x5, 4', { 5: 0x1 }, 0x0292, 2, { 5: 0x10 });

    // c.lwsp x5, 4(x2)     -> 0x4292        ; decompresses to lw x5, 4(x2)
    chip.writeUint32(STACK + 4, 0xdeadbeef);
    run(cpu, 'c.lwsp x5, 4(x2)', { 2: STACK }, 0x4292, 2, { 5: 0xdeadbeef });

    // c.jr x5              -> 0x8282        ; decompresses to jalr x0, x5, 0
    run(cpu, 'c.jr x5', { 5: TRAPHANDLER }, 0x8282, TRAPHANDLER - SCRATCH, {});

    // c.mv x5, x6          -> 0x829a        ; decompresses to add x5, x0, x6
    run(cpu, 'c.mv x5, x6', { 6: 0x42 }, 0x829a, 2, { 5: 0x42 });

    // c.ebreak             -> 0x9002        ; decompresses to ebreak -> trap
    cpu.csrs[0x305] = TRAPHANDLER; // mtvec
    run(cpu, 'c.ebreak', {}, 0x9002, TRAPHANDLER - SCRATCH, {});
    expect(cpu.csrs[0x342]).toBe(3); // mcause

    // c.jalr x1, x5        -> 0x9282        ; decompresses to jalr x1, x5, 0
    run(cpu, 'c.jalr x1, x5', { 5: TRAPHANDLER }, 0x9282, TRAPHANDLER - SCRATCH, {
      1: 0x20000002,
    });

    // c.add x5, x6         -> 0x929a        ; decompresses to add x5, x5, x6
    run(cpu, 'c.add x5, x6', { 5: 3, 6: 5 }, 0x929a, 2, { 5: 8 });

    // c.swsp x5, 4(x2)     -> 0xc216        ; decompresses to sw x5, 4(x2)
    run(cpu, 'c.swsp x5, 4(x2)', { 2: STACK, 5: 0xcafef00d }, 0xc216, 2, {});
    expect(chip.readUint32(STACK + 4)).toBe(0xcafef00d);

    // Zcmp push/pop manipulate the stack directly (no decompression to one
    // 32-bit instruction). cm.popret also performs an implicit "ret".
    // cm.push {ra}, -16     -> 0xb842        ; pushes x1 at sp-4, sp -= 16
    run(cpu, 'cm.push {ra}, -16', { 2: STACK, 1: 0xdeadbeef }, 0xb842, 2, {
      2: STACK - 16,
      1: 0xdeadbeef,
    });
    expect(chip.readUint32(STACK - 4)).toBe(0xdeadbeef);

    // cm.popret {ra}, 16    -> 0xbe42        ; restores x1, sp += 16, then ret
    chip.writeUint32(STACK + 12, TRAPHANDLER);
    run(cpu, 'cm.popret {ra}, 16', { 2: STACK, 1: 0 }, 0xbe42, TRAPHANDLER - SCRATCH, {
      1: TRAPHANDLER,
      2: STACK + 16,
    });

    // cm.pop {ra}, 16       -> 0xba42        ; restores x1, sp += 16, no ret
    chip.writeUint32(STACK + 12, 0x12345678);
    run(cpu, 'cm.pop {ra}, 16', { 2: STACK, 1: 0 }, 0xba42, 2, {
      1: 0x12345678,
      2: STACK + 16,
    });

    // cm.popretz {ra}, 16   -> 0xbc42        ; restores x1, sp += 16, a0 <- 0, ret
    chip.writeUint32(STACK + 12, TRAPHANDLER);
    run(cpu, 'cm.popretz {ra}, 16', { 2: STACK, 1: 0, 10: 0x42 }, 0xbc42, TRAPHANDLER - SCRATCH, {
      1: TRAPHANDLER,
      2: STACK + 16,
      10: 0,
    });

    // cm.mvsa01 s0, s1      -> 0xac26        ; s0 <- a0, s1 <- a1
    run(cpu, 'cm.mvsa01 s0, s1', { 10: 0xaa, 11: 0xbb }, 0xac26, 2, { 8: 0xaa, 9: 0xbb });

    // cm.mva01s s0, s1      -> 0xac66        ; a0 <- s0, a1 <- s1
    run(cpu, 'cm.mva01s s0, s1', { 8: 0xcc, 9: 0xdd }, 0xac66, 2, { 10: 0xcc, 11: 0xdd });
  });
});
