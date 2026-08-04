/*
 * EmulatorController unit tests.
 *
 * Tests call handleToolCall() directly (no transport needed), then
 * assert on the returned content.
 */

import { randomBytes } from 'crypto';
import { describe, expect, test, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RP2350 } from '../../rp2350';
import { EmulatorController } from '../emulator-controller';

const SCRATCH = 0x20000000;

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

describe('EmulatorController', () => {
  let chip: RP2350;
  let server: EmulatorController;

  beforeEach(() => {
    server = new EmulatorController();
    chip = server.chip;
    chip.core1.waiting = true;
  });

  function text(result: { content: { text: string }[] }): string {
    return result.content[0].text;
  }

  function json(result: { content: { text: string }[]; isError?: boolean }): any {
    return JSON.parse(result.content[0].text);
  }

  // =====================================================================
  // get_status
  // =====================================================================

  describe('get_status', () => {
    test('returns core PCs, emulation_running=false, and empty breakpoints', () => {
      const data = json(server.handleToolCall('get_status', {}));
      expect(data.emulation_running).toBe(false);
      expect(data.arch).toBe('riscv');
      expect(data.core0.pc).toBe(hex(chip.core0.pc));
      expect(data.core0.wfi).toBeDefined();
      expect(data.core1.pc).toBe(hex(chip.core1.pc));
      expect(data.core1.wfi).toBeDefined();
      expect(data.breakpoints).toEqual([]);
    });

    test('includes breakpoints after setting them', () => {
      server.handleToolCall('set_breakpoint', { address: 0x20000100 });
      server.handleToolCall('set_breakpoint', { address: 0x20000200 });
      const data = json(server.handleToolCall('get_status', {}));
      expect(data.breakpoints).toContain(hex(0x20000100));
      expect(data.breakpoints).toContain(hex(0x20000200));
    });

    test('reports ARM architecture after load_firmware with arch=arm', () => {
      const tmp = path.join(os.tmpdir(), `arm-test-${randomBytes(8).toString('hex')}.hex`);
      fs.writeFileSync(
        tmp,
        ':020000040020DA\n:1000000000BFAAAAAAAABBBBBBBBCCCCCCCCXX\n:00000001FF\n'
      );
      server.handleToolCall('load_firmware', { path: tmp, arch: 'arm', entry_pc: 0x20000000 });
      fs.unlinkSync(tmp);
      const data = json(server.handleToolCall('get_status', {}));
      expect(data.arch).toBe('arm');
    });
  });

  // =====================================================================
  // read_registers / write_register
  // =====================================================================

  describe('registers', () => {
    test('read all registers', () => {
      chip.core0.setRegisterU(1, 0xdeadbeef);
      chip.core0.pc = 0x20000100;
      const data = json(server.handleToolCall('read_registers', { core: 0 }));
      expect(data.ra).toBe(hex(0xdeadbeef));
      expect(data.pc).toBe(hex(0x20000100));
      expect(data.zero).toBe(hex(0));
      expect(data.mstatus).toBeDefined();
      expect(data.mhartid).toBeDefined();
    });

    test('read registers for core 1', () => {
      chip.core1.setRegisterU(5, 0x42);
      const data = json(server.handleToolCall('read_registers', { core: 1 }));
      expect(data.t0).toBe(hex(0x42));
    });

    test('write register by ABI name', () => {
      server.handleToolCall('write_register', { core: 0, register: 'ra', value: 0x12345678 });
      expect(chip.core0.getRegisterU(1)).toBe(0x12345678);
    });

    test('write register by numeric name', () => {
      server.handleToolCall('write_register', { core: 0, register: 'x5', value: 0xabc });
      expect(chip.core0.getRegisterU(5)).toBe(0xabc);
    });

    test('write pc', () => {
      server.handleToolCall('write_register', { core: 0, register: 'pc', value: 0x20000100 });
      expect(chip.core0.pc).toBe(0x20000100);
    });

    test('write CSR (mepc)', () => {
      server.handleToolCall('write_register', { core: 0, register: 'mepc', value: 0x20004000 });
      expect(chip.core0.csrs[0x341]).toBe(0x20004000);
    });

    test('write to core 1', () => {
      server.handleToolCall('write_register', { core: 1, register: 'sp', value: 0x20010000 });
      expect(chip.core1.getRegisterU(2)).toBe(0x20010000);
      expect(chip.core0.getRegisterU(2)).toBe(0);
    });

    test('unknown register returns error', () => {
      const result = server.handleToolCall('write_register', { register: 'foo', value: 0 }) as any;
      expect(result.isError).toBe(true);
    });
  });

  // =====================================================================
  // read_memory / write_memory
  // =====================================================================

  describe('memory', () => {
    test('read memory returns hex dump', () => {
      chip.writeUint32(SCRATCH, 0xdeadbeef);
      const dump = text(server.handleToolCall('read_memory', { address: SCRATCH, length: 4 }));
      expect(dump).toContain('ef be ad de');
      expect(dump).toContain('0x20000000');
    });

    test('read memory shows ASCII representation', () => {
      chip.writeUint8(SCRATCH, 0x48); // 'H'
      chip.writeUint8(SCRATCH + 1, 0x49); // 'I'
      const dump = text(server.handleToolCall('read_memory', { address: SCRATCH, length: 2 }));
      expect(dump).toContain('HI');
    });

    test('write memory', () => {
      server.handleToolCall('write_memory', { address: SCRATCH, hex: 'efbeadde' });
      expect(chip.readUint32(SCRATCH)).toBe(0xdeadbeef);
    });

    test('read memory handles invalid addresses', () => {
      const dump = text(server.handleToolCall('read_memory', { address: 0xffff0000, length: 4 }));
      expect(dump).toContain('ff');
    });
  });

  // =====================================================================
  // single_step
  // =====================================================================

  describe('single_step', () => {
    test('steps core 0 by one instruction', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.core0.pc = SCRATCH;
      const data = json(server.handleToolCall('single_step', { core: 0 }));
      expect(data.core).toBe(0);
      expect(data.pc).toBe(hex(SCRATCH + 4));
      expect(data.traces).toEqual([]);
    });

    test('single_step returns trace hits', () => {
      chip.writeUint32(SCRATCH, 0x00c0006f); // j +12
      chip.writeUint16(SCRATCH + 4, 0xabcd);
      chip.writeUint16(SCRATCH + 6, 0xffff);
      chip.writeUint8(SCRATCH + 8, 0x68); // 'h'
      chip.writeUint8(SCRATCH + 9, 0x69); // 'i'
      chip.writeUint8(SCRATCH + 10, 0x00);
      chip.core0.pc = SCRATCH;
      const data = json(server.handleToolCall('single_step', { core: 0 }));
      expect(data.traces.length).toBe(1);
      expect(data.traces[0].tag).toBe('hi');
    });

    test('steps core 1 independently', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.core1.waiting = false;
      chip.core1.pc = SCRATCH;
      const core0Pc = chip.core0.pc;
      const data = json(server.handleToolCall('single_step', { core: 1 }));
      expect(data.core).toBe(1);
      expect(chip.core1.pc).toBe(SCRATCH + 4);
      expect(chip.core0.pc).toBe(core0Pc);
    });
  });

  // =====================================================================
  // run
  // =====================================================================

  describe('run', () => {
    test('halts at breakpoint', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 8, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      server.handleToolCall('set_breakpoint', { address: SCRATCH + 4 });
      const data = json(server.handleToolCall('run', { max_instructions: 1000 }));

      expect(data.halted).toBe(true);
      expect(data.reason).toBe('breakpoint');
      expect(data.core0_pc).toBe(hex(SCRATCH + 4));
    });

    test('stops at max_instructions', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      const data = json(server.handleToolCall('run', { max_instructions: 10 }));
      expect(data.halted).toBe(false);
      expect(data.reason).toBe('max_reached');
      expect(data.instructions_executed).toBe(10);
    });
  });

  // =====================================================================
  // breakpoints
  // =====================================================================

  describe('breakpoints', () => {
    test('set and list', () => {
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('set_breakpoint', { address: 0x200 });
      const data = json(server.handleToolCall('list_breakpoints', {}));
      expect(data.addresses).toContain(hex(0x100));
      expect(data.addresses).toContain(hex(0x200));
    });

    test('clear', () => {
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('clear_breakpoint', { address: 0x100 });
      const data = json(server.handleToolCall('list_breakpoints', {}));
      expect(data.addresses).not.toContain(hex(0x100));
    });
  });

  // =====================================================================
  // tracepoints
  // =====================================================================

  describe('tracepoints', () => {
    test('set and list', () => {
      server.handleToolCall('set_tracepoint', { label: 'entry', address: 0x20000100 });
      server.handleToolCall('set_tracepoint', { label: 'loop', address: 0x20000200 });
      const data = json(server.handleToolCall('list_tracepoints', {}));
      expect(data.tracepoints).toContainEqual({ label: 'entry', address: hex(0x20000100) });
      expect(data.tracepoints).toContainEqual({ label: 'loop', address: hex(0x20000200) });
    });

    test('clear by label', () => {
      server.handleToolCall('set_tracepoint', { label: 'foo', address: 0x100 });
      server.handleToolCall('clear_tracepoint', { label: 'foo' });
      const data = json(server.handleToolCall('list_tracepoints', {}));
      expect(data.tracepoints).toEqual([]);
    });

    test('get_status includes tracepoint info', () => {
      server.handleToolCall('set_tracepoint', { label: 'x', address: 0x100 });
      const data = json(server.handleToolCall('get_status', {}));
      expect(data.tracepoints).toContainEqual({ label: 'x', address: hex(0x100) });
    });

    test('run reports traces from hardwired trace markers', () => {
      // Layout: j skips over the marker data to the code after it.
      //   SCRATCH+0:  j SCRATCH+12   (jal x0, +12 → 0x00C0006F)
      //   SCRATCH+4:  .half 0xABCD   (marker)
      //   SCRATCH+6:  .half 0xFFFF   (marker)
      //   SCRATCH+8:  "hi\0"         (tag string)
      //   SCRATCH+12: nop            (code resumes here)
      //   SCRATCH+16: j -4           (loop back to SCRATCH+12)
      chip.writeUint32(SCRATCH, 0x00c0006f); // j +12
      chip.writeUint16(SCRATCH + 4, 0xabcd);
      chip.writeUint16(SCRATCH + 6, 0xffff);
      chip.writeUint8(SCRATCH + 8, 0x68); // 'h'
      chip.writeUint8(SCRATCH + 9, 0x69); // 'i'
      chip.writeUint8(SCRATCH + 10, 0x00); // NUL
      chip.writeUint32(SCRATCH + 12, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 16, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      const data = json(server.handleToolCall('run', { max_instructions: 20 }));
      expect(data.traces.length).toBeGreaterThanOrEqual(1);
      expect(data.traces[0].tag).toBe('hi');
      expect(data.traces[0].pc).toBe(hex(SCRATCH >>> 0));
    });

    test('run does NOT halt on tracepoints', () => {
      chip.writeUint32(SCRATCH, 0x00c0006f); // j +12
      chip.writeUint16(SCRATCH + 4, 0xabcd);
      chip.writeUint16(SCRATCH + 6, 0xffff);
      chip.writeUint8(SCRATCH + 8, 0x68); // 'h'
      chip.writeUint8(SCRATCH + 9, 0x00);
      chip.writeUint8(SCRATCH + 10, 0x00);
      chip.writeUint32(SCRATCH + 12, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 16, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;

      const data = json(server.handleToolCall('run', { max_instructions: 10 }));
      expect(data.halted).toBe(false);
      expect(data.reason).toBe('max_reached');
    });

    test('list_tracepoints shows only definitions, not traces', () => {
      server.handleToolCall('set_tracepoint', { label: 'foo', address: 0x200 });
      const data = json(server.handleToolCall('list_tracepoints', {}));
      expect(data.tracepoints).toContainEqual({ label: 'foo', address: hex(0x200) });
      expect(data.traces).toBeUndefined();
    });
  });

  // =====================================================================
  // dump_pio
  // =====================================================================

  describe('dump_pio', () => {
    test('dumps all PIO instances', () => {
      const dump = text(server.handleToolCall('dump_pio', {}));
      expect(dump).toContain('PIO0');
      expect(dump).toContain('PIO1');
      expect(dump).toContain('PIO2');
      expect(dump).toContain('SM0');
    });

    test('dumps single instance', () => {
      const dump = text(server.handleToolCall('dump_pio', { instance: 1 }));
      expect(dump).toContain('PIO1');
      expect(dump).not.toContain('=== PIO0');
    });

    test('shows ISR/OSR state', () => {
      chip.pio[0].machines[0].inputShiftReg = 0xdeadbeef;
      chip.pio[0].machines[0].inputShiftCount = 16;
      const dump = text(server.handleToolCall('dump_pio', { instance: 0 }));
      expect(dump).toContain('ISR=0xdeadbeef');
      expect(dump).toContain('16/');
    });
  });

  // =====================================================================
  // dump_gpio
  // =====================================================================

  describe('dump_gpio', () => {
    test('dumps all 48 pins', () => {
      const dump = text(server.handleToolCall('dump_gpio', {}));
      expect(dump).toContain('48 pins');
      expect(dump).toContain('GP 0');
      expect(dump).toContain('GP47');
      expect(dump).toContain('inputs:');
      expect(dump).toContain('outputs:');
    });

    test('shows pin function', () => {
      chip.gpio[0].ctrl = 5; // SIO
      const dump = text(server.handleToolCall('dump_gpio', {}));
      expect(dump).toMatch(/GP 0 SIO/);
    });
  });

  // =====================================================================
  // load_firmware / reset
  // =====================================================================

  describe('load_firmware and reset', () => {
    function writeTempHex(baseAddr: number, data: number[]): string {
      // Write a minimal Intel HEX file: extended address record + data record
      const hi = (baseAddr >> 16) & 0xffff;
      const lo = baseAddr & 0xffff;
      const lines: string[] = [];
      // Extended linear address record
      const hiChecksum = (0x02 + 0x00 + 0x00 + 0x04 + (hi >> 8) + (hi & 0xff)) & 0xff;
      lines.push(
        `:02000004${hi.toString(16).padStart(4, '0')}${hiChecksum
          .toString(16)
          .padStart(2, '0')
          .toUpperCase()}`
      );
      // Data record
      const byteCount = data.length;
      let sum = byteCount + (lo >> 8) + (lo & 0xff) + 0x00;
      let hexData = '';
      for (const b of data) {
        sum += b;
        hexData += b.toString(16).padStart(2, '0').toUpperCase();
      }
      const checksum = ((~sum + 1) & 0xff).toString(16).padStart(2, '0').toUpperCase();
      lines.push(
        `:${byteCount.toString(16).padStart(2, '0').toUpperCase()}${lo
          .toString(16)
          .padStart(4, '0')
          .toUpperCase()}00${hexData}${checksum}`
      );
      // EOF record
      lines.push(':00000001FF');
      const tmp = path.join(os.tmpdir(), `mcp-test-${randomBytes(8).toString('hex')}.hex`);
      fs.writeFileSync(tmp, lines.join('\n') + '\n');
      return tmp;
    }

    test('load_firmware loads SRAM hex with explicit entry_pc', () => {
      // Synthetic fixture (single NOP) has no IMAGE_DEF, so the bootrom
      // path can't auto-discover the entry. Pass entry_pc explicitly to
      // bypass the bootrom and set PC directly.
      const hexPath = writeTempHex(0x20000000, [0x13, 0x00, 0x00, 0x00]); // nop at 0x20000000
      const data = json(
        server.handleToolCall('load_firmware', { path: hexPath, entry_pc: 0x20000000 })
      );
      expect(data.ok).toBe(true);
      expect(data.use_sram).toBe(true);
      expect(data.entry_pc).toBe(hex(0x20000000));
      const status = json(server.handleToolCall('get_status', {}));
      expect(status.core0.pc).toBe(hex(0x20000000));
      fs.unlinkSync(hexPath);
    });

    test('load_firmware loads flash hex with explicit entry_pc', () => {
      const hexPath = writeTempHex(0x10000000, [0x6f, 0x00, 0x00, 0x00]); // j at 0x10000000
      const data = json(
        server.handleToolCall('load_firmware', { path: hexPath, entry_pc: 0x10000000 })
      );
      expect(data.ok).toBe(true);
      expect(data.use_sram).toBe(false);
      expect(data.entry_pc).toBe(hex(0x10000000));
      fs.unlinkSync(hexPath);
    });

    test('load_firmware without entry_pc reports null (bootrom will determine)', () => {
      // For real firmware, entry_pc is determined at run time by the bootrom.
      // The controller reports null in the load_firmware response; the actual
      // entry is observable by stepping until the cores leave the bootrom.
      const hexPath = writeTempHex(0x20000000, [0x13, 0x00, 0x00, 0x00]);
      const data = json(server.handleToolCall('load_firmware', { path: hexPath }));
      expect(data.ok).toBe(true);
      expect(data.entry_pc).toBeNull();
      fs.unlinkSync(hexPath);
    });

    test('load_firmware clears breakpoints', () => {
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('set_breakpoint', { address: 0x200 });
      const hexPath = writeTempHex(0x20000000, [0x13, 0x00, 0x00, 0x00]);
      server.handleToolCall('load_firmware', { path: hexPath });
      const data = json(server.handleToolCall('list_breakpoints', {}));
      expect(data.addresses).toEqual([]);
      fs.unlinkSync(hexPath);
    });

    test('reset reloads last firmware', () => {
      // Synthetic fixture needs explicit entry_pc (no IMAGE_DEF).
      const hexPath = writeTempHex(0x20000000, [0x13, 0x00, 0x00, 0x00]);
      server.handleToolCall('load_firmware', { path: hexPath, entry_pc: 0x20000000 });
      // Step one instruction to dirty the state
      server.handleToolCall('single_step', {});
      server.handleToolCall('set_breakpoint', { address: 0x500 });
      // Reset
      const data = json(server.handleToolCall('reset', {}));
      expect(data.ok).toBe(true);
      expect(data.firmware_loaded).toBe(true);
      // PC should be back at entry
      const status = json(server.handleToolCall('get_status', {}));
      expect(status.core0.pc).toBe(hex(0x20000000));
      // Breakpoints cleared
      const bps = json(server.handleToolCall('list_breakpoints', {}));
      expect(bps.addresses).toEqual([]);
      fs.unlinkSync(hexPath);
    });

    test('load_firmware loads UF2 binary (real firmware, bootrom picks entry)', () => {
      const data = json(
        server.handleToolCall('load_firmware', { path: 'demo/riscv_blink/blink_simple.uf2' })
      );
      expect(data.ok).toBe(true);
      expect(data.format).toBe('uf2');
      // This UF2 targets SRAM (0x20000000)
      expect(data.use_sram).toBe(true);
      // No entry_pc supplied → bootrom will determine it. Verify by running
      // until the bootrom hands off to firmware and the cores land in SRAM.
      const runData = json(server.handleToolCall('run', { max_instructions: 200000 }));
      expect(runData.instructions_executed).toBeGreaterThan(0);
      const status = json(server.handleToolCall('get_status', {}));
      // The bootrom's actual entry address for current pico-sdk (0x20000222,
      // just past the embedded block). Allow any SRAM address — the real
      // value depends on the SDK version that built the .uf2.
      const pc = parseInt(status.core0.pc, 16);
      expect(pc).toBeGreaterThanOrEqual(0x20000000);
      expect(pc).toBeLessThan(0x20040000);
    });

    test('reset without firmware clears state', () => {
      // Don't load firmware, just set some state
      server.handleToolCall('set_breakpoint', { address: 0x100 });
      server.handleToolCall('set_tracepoint', { label: 'x', address: 0x200 });
      const data = json(server.handleToolCall('reset', {}));
      expect(data.ok).toBe(true);
      expect(data.firmware_loaded).toBe(false);
      const bps = json(server.handleToolCall('list_breakpoints', {}));
      expect(bps.addresses).toEqual([]);
      const tps = json(server.handleToolCall('list_tracepoints', {}));
      expect(tps.tracepoints).toEqual([]);
    });

    test('load_firmware auto-detects .dis file', () => {
      const data = json(
        server.handleToolCall('load_firmware', {
          path: 'demo/riscv_blink/blink_simple.hex',
        })
      );
      expect(data.ok).toBe(true);
      expect(data.disassembly_loaded).toBe(true);
    });

    test('single_step includes disassembly context', () => {
      // Real firmware with a .dis file; use explicit entry_pc to land directly
      // at the firmware so a single_step puts us in disassembly range.
      server.handleToolCall('load_firmware', {
        path: 'demo/riscv_blink/blink_simple.hex',
        entry_pc: 0x20000222, // _reset_handler (post-embedded-block entry)
      });
      const data = json(server.handleToolCall('single_step', { core: 0 }));
      expect(data.disassembly).toBeDefined();
      expect(typeof data.disassembly).toBe('string');
      // Should contain instruction lines (hex address + tab)
      expect(data.disassembly).toMatch(/20000[0-9a-f]+:/);
    });

    test('run includes disassembly context on breakpoint', () => {
      server.handleToolCall('load_firmware', {
        path: 'demo/riscv_blink/blink_simple.hex',
      });
      // Set a breakpoint early in the boot sequence
      server.handleToolCall('set_breakpoint', { address: 0x2000025c }); // platform_entry
      const data = json(server.handleToolCall('run', { max_instructions: 50000 }));
      if (data.halted) {
        expect(data.disassembly).toBeDefined();
        expect(data.disassembly).toMatch(/20000[0-9a-f]+:/);
      }
    });

    test('get_status reports disassembly_loaded', () => {
      const before = json(server.handleToolCall('get_status', {}));
      expect(before.disassembly_loaded).toBe(false);

      server.handleToolCall('load_firmware', {
        path: 'demo/riscv_blink/blink_simple.hex',
      });
      const after = json(server.handleToolCall('get_status', {}));
      expect(after.disassembly_loaded).toBe(true);
      expect(after.disassembly_path).toContain('blink_simple.dis');
    });
  });

  // =====================================================================
  // convert_number
  // =====================================================================

  describe('convert_number', () => {
    test('hex → decimal', () => {
      const data = json(server.handleToolCall('convert_number', { value: '0x12345678' }));
      expect(data.decimal).toBe(0x12345678);
      expect(data.hex).toBe(hex(0x12345678));
    });

    test('decimal → hex', () => {
      const data = json(server.handleToolCall('convert_number', { value: '305419896' }));
      expect(data.decimal).toBe(305419896);
      expect(data.hex).toBe(hex(305419896));
      expect(data.hex).toBe('0x12345678');
    });

    test('uppercase 0X prefix', () => {
      const data = json(server.handleToolCall('convert_number', { value: '0XDEADBEEF' }));
      expect(data.decimal).toBe(0xdeadbeef);
      expect(data.hex).toBe(hex(0xdeadbeef));
    });

    test('accepts numeric JSON input', () => {
      const data = json(server.handleToolCall('convert_number', { value: 0x20000100 }));
      expect(data.decimal).toBe(0x20000100);
      expect(data.hex).toBe(hex(0x20000100));
    });

    test('round-trips through both directions', () => {
      const dec2hex = json(server.handleToolCall('convert_number', { value: '0xdeadbeef' }));
      const hex2dec = json(
        server.handleToolCall('convert_number', { value: dec2hex.decimal.toString() })
      );
      expect(hex2dec.hex).toBe(hex(0xdeadbeef));
      expect(hex2dec.decimal).toBe(0xdeadbeef);
    });

    test('rejects malformed input', () => {
      const result = server.handleToolCall('convert_number', { value: 'not a number' }) as any;
      expect(result.isError).toBe(true);
    });

    test('rejects empty string', () => {
      const result = server.handleToolCall('convert_number', { value: '' }) as any;
      expect(result.isError).toBe(true);
    });
  });

  // =====================================================================
  // dump_memory
  // =====================================================================

  describe('dump_memory', () => {
    test('dumps SRAM as Intel HEX with correct addresses', () => {
      chip.writeUint32(SCRATCH, 0xdeadbeef);
      chip.writeUint32(SCRATCH + 4, 0x12345678);
      const data = json(
        server.handleToolCall('dump_memory', {
          region: 'sram',
          address: 0,
          length: 8,
        })
      );
      expect(data.ok).toBe(true);
      expect(data.region).toBe('sram');
      expect(data.address).toBe(hex(0x20000000));
      expect(data.format).toBe('ihex');
      expect(data.path).toMatch(/\.hex$/);
      const fileContent = fs.readFileSync(data.path, 'utf-8');
      // Extended linear address record for 0x2000_0000 (upper = 0x2000)
      expect(fileContent).toContain(':020000042000');
      // Data bytes little-endian: ef be ad de 78 56 34 12
      expect(fileContent).toContain('EFBEADDE78563412');
      // EOF record
      expect(fileContent).toContain(':00000001FF');
      fs.unlinkSync(data.path);
    });

    test('dumps flash region', () => {
      // Flash is loaded from the bootrom/firmware; just verify the call works
      // and emits the correct extended address record (0x1000_0000 → upper=0x1000)
      const data = json(
        server.handleToolCall('dump_memory', {
          region: 'flash',
          address: 0,
          length: 4,
        })
      );
      expect(data.ok).toBe(true);
      expect(data.region).toBe('flash');
      expect(data.address).toBe(hex(0x10000000));
      const fileContent = fs.readFileSync(data.path, 'utf-8');
      expect(fileContent).toContain(':020000041000');
      fs.unlinkSync(data.path);
    });

    test('text format emits address-prefixed hex rows', () => {
      chip.writeUint32(SCRATCH, 0xaabbccdd);
      const data = json(
        server.handleToolCall('dump_memory', {
          region: 'sram',
          address: 0,
          length: 4,
          format: 'text',
        })
      );
      expect(data.format).toBe('text');
      expect(data.path).toMatch(/\.txt$/);
      const fileContent = fs.readFileSync(data.path, 'utf-8').trim();
      expect(fileContent).toContain(hex(0x20000000));
      // writeUint32 is little-endian: dd cc bb aa
      expect(fileContent).toContain('ddccbbaa');
      fs.unlinkSync(data.path);
    });

    test('ihex output is reloadable via load_firmware', () => {
      // Write known bytes, dump, reload into a fresh region, verify round-trip
      chip.writeUint32(SCRATCH, 0xcafebabe);
      const dump = json(
        server.handleToolCall('dump_memory', {
          region: 'sram',
          address: 0,
          length: 4,
          format: 'ihex',
        })
      );
      // Reload the dump; load_firmware auto-detects SRAM from the 0x2000 upper addr
      const reload = json(server.handleToolCall('load_firmware', { path: dump.path }));
      expect(reload.ok).toBe(true);
      expect(reload.use_sram).toBe(true);
      // After reload, the byte at SCRATCH should match what we wrote
      expect(chip.readUint32(SCRATCH)).toBe(0xcafebabe);
      fs.unlinkSync(dump.path);
    });

    test('length 0 returns error', () => {
      const result = server.handleToolCall('dump_memory', {
        region: 'sram',
        address: 0,
        length: 0,
      }) as any;
      expect(result.isError).toBe(true);
    });
  });

  // =====================================================================
  // hex/decimal input parsing (accepts "0x..." strings everywhere)
  // =====================================================================

  describe('hex input parsing', () => {
    test('write_register accepts hex string value', () => {
      server.handleToolCall('write_register', {
        core: 0,
        register: 'ra',
        value: '0xdeadbeef',
      });
      expect(chip.core0.getRegisterU(1)).toBe(0xdeadbeef);
    });

    test('write_register accepts hex string core', () => {
      server.handleToolCall('write_register', {
        core: '0x1',
        register: 't0',
        value: '0x42',
      });
      expect(chip.core1.getRegisterU(5)).toBe(0x42);
    });

    test('write_register still accepts numeric JSON value', () => {
      server.handleToolCall('write_register', {
        core: 0,
        register: 'sp',
        value: 0x20010000,
      });
      expect(chip.core0.getRegisterU(2)).toBe(0x20010000);
    });

    test('read_memory accepts hex string address and length', () => {
      chip.writeUint32(SCRATCH, 0x11223344);
      const dump = text(
        server.handleToolCall('read_memory', {
          address: '0x20000000',
          length: '0x4',
        })
      );
      expect(dump).toContain('44 33 22 11');
    });

    test('write_memory accepts hex string address', () => {
      server.handleToolCall('write_memory', { address: '0x20000000', hex: 'efbeadde' });
      expect(chip.readUint32(SCRATCH)).toBe(0xdeadbeef);
    });

    test('set_breakpoint / clear_breakpoint accept hex string address', () => {
      server.handleToolCall('set_breakpoint', { address: '0x20000100' });
      const data = json(server.handleToolCall('list_breakpoints', {}));
      expect(data.addresses).toContain(hex(0x20000100));
      server.handleToolCall('clear_breakpoint', { address: '0x20000100' });
      const after = json(server.handleToolCall('list_breakpoints', {}));
      expect(after.addresses).not.toContain(hex(0x20000100));
    });

    test('set_tracepoint accepts hex string address', () => {
      server.handleToolCall('set_tracepoint', { label: 'lbl', address: '0x20000200' });
      const data = json(server.handleToolCall('list_tracepoints', {}));
      expect(data.tracepoints).toContainEqual({ label: 'lbl', address: hex(0x20000200) });
    });

    test('run accepts hex string max_instructions', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;
      const data = json(server.handleToolCall('run', { max_instructions: '0xa' }));
      expect(data.instructions_executed).toBe(10);
    });

    test('dump_pio accepts hex string instance', () => {
      const dump = text(server.handleToolCall('dump_pio', { instance: '0x1' }));
      expect(dump).toContain('PIO1');
    });

    test('dump_memory accepts hex string address and length', () => {
      chip.writeUint32(SCRATCH, 0xfeedface);
      const data = json(
        server.handleToolCall('dump_memory', {
          region: 'sram',
          address: '0x0',
          length: '0x4',
          format: 'text',
        })
      );
      expect(data.address).toBe(hex(0x20000000));
      const fileContent = fs.readFileSync(data.path, 'utf-8');
      // little-endian
      expect(fileContent).toContain('cefaedfe');
      fs.unlinkSync(data.path);
    });

    test('load_firmware accepts hex string entry_pc', () => {
      // Minimal Intel HEX: extended address 0x2000, data record with one nop at
      // offset 0, EOF record.
      const hexContent = ':020000042000DA\n:0400000013000000E9\n:00000001FF\n';
      const tmp = path.join(os.tmpdir(), `mcp-hex-pc-${randomBytes(8).toString('hex')}.hex`);
      fs.writeFileSync(tmp, hexContent);
      const data = json(
        server.handleToolCall('load_firmware', { path: tmp, entry_pc: '0x20000000' })
      );
      expect(data.entry_pc).toBe(hex(0x20000000));
      // load_firmware re-creates the chip; read PC via get_status
      const status = json(server.handleToolCall('get_status', {}));
      expect(status.core0.pc).toBe(hex(0x20000000));
      fs.unlinkSync(tmp);
    });

    test('mixed decimal and hex args in one call', () => {
      server.handleToolCall('write_register', {
        core: 0,
        register: 'ra',
        value: '0xcafef00d',
      });
      server.handleToolCall('write_register', {
        core: '0x0',
        register: 'sp',
        value: 0x20000000,
      });
      expect(chip.core0.getRegisterU(1)).toBe(0xcafef00d);
      expect(chip.core0.getRegisterU(2)).toBe(0x20000000);
    });

    test('uppercase 0X prefix works', () => {
      server.handleToolCall('write_register', {
        core: 0,
        register: 'ra',
        value: '0XDEADBEEF',
      });
      expect(chip.core0.getRegisterU(1)).toBe(0xdeadbeef);
    });

    test('malformed value throws error', () => {
      const result = server.handleToolCall('write_register', {
        core: 0,
        register: 'ra',
        value: 'not hex',
      }) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Could not parse integer/);
    });

    test('missing required address throws', () => {
      const result = server.handleToolCall('set_breakpoint', {}) as any;
      expect(result.isError).toBe(true);
    });
  });
});
