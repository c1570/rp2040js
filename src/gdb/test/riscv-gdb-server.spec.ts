/*
 * RISC-V GDB Server tests.
 *
 * Tests the GDB Remote Serial Protocol implementation for the RP2350
 * RISC-V (Hazard3) dual-core emulator.
 */

import { describe, expect, test, beforeEach } from 'vitest';
import { RP2350 } from '../../rp2350';
import { RISCVGDBServer } from '../riscv-gdb-server';
import { gdbMessage, decodeHexUint32 } from '../gdb-utils';

const SCRATCH = 0x20000000;

describe('RISC-V GDB Server', () => {
  let chip: RP2350;
  let server: RISCVGDBServer;

  beforeEach(() => {
    chip = new RP2350();
    chip.core1.waiting = true;
    server = new RISCVGDBServer(chip);
  });

  // Helper: strip $...#checksum wrapper to get the payload
  function payload(response: string | void): string {
    expect(response).toBeDefined();
    const r = response!;
    const start = r.indexOf('$') + 1;
    const end = r.lastIndexOf('#');
    return r.substring(start, end);
  }

  // Helper: decode a hex register blob into an array of uint32 values
  // GDB sends registers as hex-encoded byte sequences in target byte order (LE)
  function decodeRegs(hex: string): number[] {
    const regs: number[] = [];
    for (let i = 0; i < hex.length; i += 8) {
      regs.push(decodeHexUint32(hex.substring(i, i + 8)));
    }
    return regs;
  }

  // =====================================================================
  // Query / protocol support
  // =====================================================================

  describe('protocol queries', () => {
    test('qSupported advertises features', () => {
      const r = payload(server.processGDBMessage('qSupported:swbreak+'));
      expect(r).toContain('PacketSize=4000');
      expect(r).toContain('vContSupported+');
      expect(r).toContain('qXfer:features:read+');
    });

    test('qAttached returns 1', () => {
      expect(payload(server.processGDBMessage('qAttached'))).toBe('1');
    });

    test('qXfer:features:read:target.xml returns XML', () => {
      const r = payload(server.processGDBMessage('qXfer:features:read:target.xml:0,1000'));
      expect(r).toMatch(/^l<\?xml/);
      expect(r).toContain('<architecture>riscv</architecture>');
      expect(r).toContain('org.gnu.gdb.riscv.cpu');
      expect(r).toContain('org.gnu.gdb.riscv.csr');
      expect(r).toContain('name="pc"');
      expect(r).toContain('name="mstatus"');
    });

    test('qfThreadInfo lists both cores', () => {
      expect(payload(server.processGDBMessage('qfThreadInfo'))).toBe('m1,2');
      expect(payload(server.processGDBMessage('qsThreadInfo'))).toBe('l');
    });

    test('qHostInfo returns riscv32 triple', () => {
      const r = payload(server.processGDBMessage('qHostInfo'));
      expect(r).toContain('endian:little');
      expect(r).toContain('ptrsize:4');
    });
  });

  // =====================================================================
  // Thread selection
  // =====================================================================

  describe('thread selection', () => {
    test('Hg1 selects core 0', () => {
      expect(payload(server.processGDBMessage('Hg1'))).toBe('OK');
    });

    test('Hg2 selects core 1', () => {
      expect(payload(server.processGDBMessage('Hg2'))).toBe('OK');
    });

    test('Hg0 defaults to OK', () => {
      expect(payload(server.processGDBMessage('Hg0'))).toBe('OK');
    });

    test('Hg3 returns error', () => {
      expect(payload(server.processGDBMessage('Hg3'))).toBe('E01');
    });
  });

  // =====================================================================
  // Register read/write
  // =====================================================================

  describe('register access', () => {
    test('read all registers (g)', () => {
      chip.core0.setRegisterU(1, 0xdeadbeef);
      chip.core0.pc = 0x20000100;

      const r = payload(server.processGDBMessage('g'));
      const regs = decodeRegs(r);
      // 32 GPRs + pc + 7 CSRs = 40 registers
      expect(regs.length).toBe(40);
      expect(regs[1]).toBe(0xdeadbeef); // x1 = ra
      expect(regs[32]).toBe(0x20000100); // pc
      // x0 is always 0
      expect(regs[0]).toBe(0);
    });

    test('read single register (p)', () => {
      chip.core0.setRegisterU(5, 0x12345678);

      const r = payload(server.processGDBMessage('p05'));
      expect(r).toBe('78563412'); // little-endian hex
    });

    test('read pc register', () => {
      chip.core0.pc = 0x20000100;
      const r = payload(server.processGDBMessage('p20')); // 0x20 = 32 = pc
      expect(r).toBe('00010020'); // little-endian
    });

    test('read CSR (mstatus)', () => {
      const mstatus = chip.core0.csrs[0x300] >>> 0;
      const r = payload(server.processGDBMessage('p21')); // 0x21 = 33 = first CSR
      expect(decodeHexUint32(r)).toBe(mstatus);
    });

    test('write single register (P)', () => {
      server.processGDBMessage('P05=78563412'); // 0x12345678 LE
      expect(chip.core0.getRegisterU(5)).toBe(0x12345678);
    });

    test('write pc register', () => {
      // 0x20000100 LE = 00 01 00 20 → hex "00010020"
      server.processGDBMessage('P20=00010020');
      expect(chip.core0.pc).toBe(0x20000100);
    });

    test('write CSR (mepc)', () => {
      // mepc is regnum 36 = 0x24
      // 0x20001000 LE = 00 10 00 20 → hex "00100020"
      server.processGDBMessage('P24=00100020');
      expect(chip.core0.csrs[0x341]).toBe(0x20001000);
    });

    test('register access targets selected core', () => {
      // Set different values in each core
      chip.core0.setRegisterU(1, 0xaaaaaaaa);
      chip.core1.setRegisterU(1, 0xbbbbbbbb);

      // Default is core 0
      expect(decodeRegs(payload(server.processGDBMessage('g')))[1]).toBe(0xaaaaaaaa);

      // Switch to core 1
      server.processGDBMessage('Hg2');
      expect(decodeRegs(payload(server.processGDBMessage('g')))[1]).toBe(0xbbbbbbbb);
    });
  });

  // =====================================================================
  // Memory read/write
  // =====================================================================

  describe('memory access', () => {
    test('read memory (m)', () => {
      chip.writeUint32(SCRATCH, 0xdeadbeef);
      const r = payload(server.processGDBMessage('m20000000,4'));
      expect(r).toBe('efbeadde'); // little-endian
    });

    test('write memory (M)', () => {
      server.processGDBMessage('M20000000,4:efbeadde');
      expect(chip.readUint32(SCRATCH)).toBe(0xdeadbeef);
    });

    test('binary write memory (X)', () => {
      // X packet: raw bytes after the colon (no hex encoding)
      server.processGDBMessage('X20000000,4:\xef\xbe\xad\xde');
      expect(chip.readUint32(SCRATCH)).toBe(0xdeadbeef);
    });

    test('binary write with escape sequences (X)', () => {
      // GDB escapes } $ # * in binary data as } followed by (char ^ 0x20).
      // Wire bytes 0x41 0x7d 0x23 0x42: 0x7d escapes to } 0x5d, 0x23 to } 0x03.
      server.processGDBMessage('X20000000,4:\x41\x7d\x5d\x7d\x03\x42');
      expect(chip.readUint8(SCRATCH)).toBe(0x41);
      expect(chip.readUint8(SCRATCH + 1)).toBe(0x7d); // unescaped '}'
      expect(chip.readUint8(SCRATCH + 2)).toBe(0x23); // unescaped '#'
      expect(chip.readUint8(SCRATCH + 3)).toBe(0x42);
    });

    test('read memory across byte boundaries', () => {
      chip.writeUint8(SCRATCH, 0x01);
      chip.writeUint8(SCRATCH + 1, 0x02);
      chip.writeUint8(SCRATCH + 2, 0x03);
      chip.writeUint8(SCRATCH + 3, 0x04);
      const r = payload(server.processGDBMessage('m20000000,4'));
      expect(r).toBe('01020304');
    });
  });

  // =====================================================================
  // Breakpoints
  // =====================================================================

  describe('breakpoints', () => {
    test('set software breakpoint (Z0)', () => {
      expect(payload(server.processGDBMessage('Z0,20000100,4'))).toBe('OK');
    });

    test('clear software breakpoint (z0)', () => {
      server.processGDBMessage('Z0,20000100,4');
      expect(payload(server.processGDBMessage('z0,20000100,4'))).toBe('OK');
    });

    test('set hardware breakpoint (Z1)', () => {
      expect(payload(server.processGDBMessage('Z1,20000200,4'))).toBe('OK');
    });

    test('clear hardware breakpoint (z1)', () => {
      server.processGDBMessage('Z1,20000200,4');
      expect(payload(server.processGDBMessage('z1,20000200,4'))).toBe('OK');
    });

    test('breakpoint triggers halt during execute', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 8, 0xff5ff06f); // j SCRATCH (jump back)
      chip.core0.pc = SCRATCH;
      chip.core1.waiting = true;

      server.processGDBMessage('Z0,20000004,4');
      server.execute();

      // execute() runs the first batch synchronously; the NOP at SCRATCH
      // advances PC to SCRATCH+4, hitting the breakpoint immediately.
      expect(server.executing).toBe(false);
      expect(chip.core0.pc).toBe(SCRATCH + 4);

      server.stop();
    });

    test('breakpoint on core 1 reports correct thread in stop reply', () => {
      // Core 0: simple loop at SCRATCH
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0xff9ff06f); // j -8 (back to SCRATCH)
      chip.core0.pc = SCRATCH;

      // Core 1: simple loop at SCRATCH+0x100
      chip.writeUint32(SCRATCH + 0x100, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 0x104, 0xff9ff06f); // j -8
      chip.core1.pc = SCRATCH + 0x100;
      chip.core1.waiting = false;

      // Breakpoint only on core 1's code
      server.processGDBMessage('Z0,20000104,4');

      // Track the stop reply
      let stopReply = '';
      server.addConnection({
        feedData() {},
        onBreakpoint(threadId: number) {
          stopReply = `thread:${threadId}`;
        },
      } as any);

      server.execute();

      expect(server.executing).toBe(false);
      expect(chip.core1.pc).toBe(SCRATCH + 0x104);
      // The stop reply must report thread 2 (core 1)
      expect(stopReply).toBe('thread:2');

      server.stop();
    });
  });

  // =====================================================================
  // Single-step
  // =====================================================================

  describe('single-step (vCont;s)', () => {
    test('step core 0 advances pc by instruction length', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop (4 bytes)
      chip.core0.pc = SCRATCH;
      chip.core1.waiting = true;

      const r = payload(server.processGDBMessage('vCont;s:1'));
      expect(r).toContain('T05');
      expect(r).toContain('thread:1');
      expect(chip.core0.pc).toBe(SCRATCH + 4);
    });

    test('step core 1 does not advance core 0', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.core0.pc = SCRATCH;
      chip.core1.pc = SCRATCH;
      chip.core1.waiting = false;

      const core0PcBefore = chip.core0.pc;
      server.processGDBMessage('vCont;s:2');

      // core 1 should have advanced
      expect(chip.core1.pc).toBe(SCRATCH + 4);
      // core 0 should not have moved
      expect(chip.core0.pc).toBe(core0PcBefore);
    });

    test('step without thread ID uses current thread', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.core0.pc = SCRATCH;

      server.processGDBMessage('Hg1'); // select core 0
      const r = payload(server.processGDBMessage('vCont;s'));
      expect(r).toContain('thread:1');
      expect(chip.core0.pc).toBe(SCRATCH + 4);
    });
  });

  // =====================================================================
  // vCont multi-action
  // =====================================================================

  describe('vCont multi-action', () => {
    test('vCont;c:1;c:2 continues both cores', () => {
      // Both cores get a NOP loop
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.writeUint32(SCRATCH + 4, 0xffdff06f); // j -4
      chip.core0.pc = SCRATCH;
      chip.core1.pc = SCRATCH;
      chip.core1.waiting = false;

      // Set breakpoint at SCRATCH+4
      server.processGDBMessage('Z0,20000004,4');
      // Continue both cores
      server.processGDBMessage('vCont;c:1;c:2');

      // execute() runs synchronously for the first batch; both cores should
      // advance to SCRATCH+4 and hit the breakpoint.
      expect(server.executing).toBe(false);
      expect(chip.core0.pc).toBe(SCRATCH + 4);
      server.stop();
    });

    test('vCont;c:1 continues only core 0', () => {
      chip.writeUint32(SCRATCH, 0x00000013); // nop
      chip.core0.pc = SCRATCH;
      chip.core1.pc = 0x20001000;
      chip.core1.waiting = false;

      server.processGDBMessage('Z0,20000004,4');
      server.processGDBMessage('vCont;c:1');

      // Only core 0 should advance; core 1 stays put
      expect(server.executing).toBe(false);
      expect(chip.core0.pc).toBe(SCRATCH + 4);
      expect(chip.core1.pc).toBe(0x20001000);
      server.stop();
    });
  });

  // =====================================================================
  // Stop reply / detach
  // =====================================================================

  describe('stop reply and detach', () => {
    test('? returns stop reply with thread ID', () => {
      const r = payload(server.processGDBMessage('?'));
      expect(r).toContain('T05');
      expect(r).toMatch(/thread:/);
    });

    test('D (detach) returns OK and stops', () => {
      expect(payload(server.processGDBMessage('D'))).toBe('OK');
      expect(server.executing).toBe(false);
    });
  });

  // =====================================================================
  // Monitor commands (qRcmd)
  // =====================================================================

  describe('monitor commands', () => {
    function decodeMonitorOutput(response: string | void): string {
      // Response is two packets: $O<hex>#cs $OK#cs
      // Extract all O-packets and decode their hex content
      let text = '';
      const r = response!;
      let idx = 0;
      while (true) {
        const oStart = r.indexOf('$O', idx);
        if (oStart < 0) break;
        const hash = r.indexOf('#', oStart);
        const hex = r.substring(oStart + 2, hash);
        text += Buffer.from(hex, 'hex').toString('ascii');
        idx = hash + 3;
      }
      return text;
    }

    test('monitor help lists available commands', () => {
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('help').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toContain('pio');
    });

    test('monitor pio dumps all PIO instances', () => {
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('pio').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toContain('PIO0');
      expect(text).toContain('PIO1');
      expect(text).toContain('PIO2');
      expect(text).toContain('SM0');
    });

    test('monitor pio 1 dumps only PIO1', () => {
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('pio 1').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toContain('PIO1');
      expect(text).not.toContain('PIO0');
    });

    test('monitor pio shows SM state', () => {
      chip.pio[0].machines[0].pc = 5;
      chip.pio[0].machines[0].x = 0x42;
      chip.pio[0].machines[0].inputShiftReg = 0xdeadbeef;
      chip.pio[0].machines[0].inputShiftCount = 16;
      chip.pio[0].machines[0].outputShiftReg = 0xcafef00d;
      chip.pio[0].machines[0].outputShiftCount = 8;
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('pio 0').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toMatch(/pc=5/);
      expect(text).toMatch(/x=0x42/);
      expect(text).toMatch(/ISR=0xdeadbeef/);
      expect(text).toMatch(/OSR=0xcafef00d/);
      expect(text).toMatch(/16\/\d+ bits/); // ISR shift count
      expect(text).toMatch(/8\/\d+ bits/); // OSR shift count
    });

    test('monitor gpio dumps all pins', () => {
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('gpio').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toContain('GPIO');
      expect(text).toContain('48 pins');
      expect(text).toContain('GP 0');
      expect(text).toContain('GP47');
    });

    test('monitor gpio shows pin function and values', () => {
      // Set GPIO 0 to SIO with output high
      chip.gpio[0].ctrl = 5; // FUNCTION_SIO
      chip.gpio[0].padValue = 0; // clear pullups
      // Set GPIO 5 to PIO0
      chip.gpio[5].ctrl = 6; // FUNCTION_PIO0

      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('gpio').toString('hex'));
      const text = decodeMonitorOutput(resp);
      // GP0 should show SIO function
      expect(text).toMatch(/GP 0 SIO/);
      // GP5 should show PIO0 function
      expect(text).toMatch(/GP 5 PIO0/);
      // Binary summary lines should be present
      expect(text).toMatch(/inputs:/);
      expect(text).toMatch(/outputs:/);
    });
  });
});
