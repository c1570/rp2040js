/*
 * ARM (Cortex-M0) GDB Server tests.
 *
 * Tests the GDB Remote Serial Protocol implementation for the RP2040
 * dual-core ARM emulator.
 */

import { describe, expect, test, beforeEach } from 'vitest';
import { Simulator } from '../../simulator';
import { RP2040 } from '../../rp2040';
import { ArmGDBServer } from '../arm-gdb-server';
import { decodeHexUint32 } from '../gdb-utils';

const SCRATCH = 0x20000000;

describe('ARM GDB Server', () => {
  let sim: Simulator<RP2040>;
  let server: ArmGDBServer;

  beforeEach(() => {
    sim = new Simulator(new RP2040());
    sim.rpchip.core1.waiting = true;
    server = new ArmGDBServer(sim);
  });

  function payload(response: string | void): string {
    expect(response).toBeDefined();
    const r = response!;
    const start = r.indexOf('$') + 1;
    const end = r.lastIndexOf('#');
    return r.substring(start, end);
  }

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

    test('qXfer:features:read:target.xml returns ARM XML', () => {
      const r = payload(server.processGDBMessage('qXfer:features:read:target.xml:0,1000'));
      expect(r).toMatch(/^l<\?xml/);
      expect(r).toContain('<architecture>arm</architecture>');
      expect(r).toContain('org.gnu.gdb.arm.m-profile');
      expect(r).toContain('org.gnu.gdb.arm.m-system');
      expect(r).toContain('name="pc"');
      expect(r).toContain('name="primask"');
    });

    test('qfThreadInfo lists both cores', () => {
      expect(payload(server.processGDBMessage('qfThreadInfo'))).toBe('m1,2');
      expect(payload(server.processGDBMessage('qsThreadInfo'))).toBe('l');
    });

    test('qHostInfo returns armv6m triple', () => {
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
      sim.rpchip.core0.registers[1] = 0xdeadbeef;
      sim.rpchip.core0.PC = 0x20000100;

      const r = payload(server.processGDBMessage('g'));
      const regs = decodeRegs(r);
      // 17 registers: r0-r15 + xPSR
      expect(regs.length).toBe(17);
      expect(regs[1]).toBe(0xdeadbeef); // r1
      expect(regs[15]).toBe(0x20000100); // pc
    });

    test('read single register (p)', () => {
      sim.rpchip.core0.registers[5] = 0x12345678;
      const r = payload(server.processGDBMessage('p05'));
      expect(decodeHexUint32(r)).toBe(0x12345678);
    });

    test('read pc register', () => {
      sim.rpchip.core0.PC = 0x20000100;
      const r = payload(server.processGDBMessage('p0f')); // 0x0f = 15 = pc
      expect(decodeHexUint32(r)).toBe(0x20000100);
    });

    test('read xPSR register', () => {
      sim.rpchip.core0.xPSR = 0x21000000;
      const r = payload(server.processGDBMessage('p10')); // 0x10 = 16 = xPSR
      expect(decodeHexUint32(r)).toBe(0x21000000);
    });

    test('read MSP register', () => {
      // 0x11 = 17 = MSP
      const r = payload(server.processGDBMessage('p11'));
      // MSP should be readable; just check it doesn't error
      expect(r.length).toBe(8);
    });

    test('write single register (P)', () => {
      // 0x12345678 LE = 78563412
      server.processGDBMessage('P05=78563412');
      expect(sim.rpchip.core0.registers[5]).toBe(0x12345678);
    });

    test('write pc register', () => {
      // 0x20000100 LE = 00010020
      server.processGDBMessage('P0f=00010020');
      expect(sim.rpchip.core0.PC).toBe(0x20000100);
    });

    test('write xPSR register', () => {
      // 0x21000000 LE = 00000021
      server.processGDBMessage('P10=00000021');
      expect(sim.rpchip.core0.xPSR).toBe(0x21000000);
    });

    test('register access targets selected core', () => {
      sim.rpchip.core0.registers[1] = 0xaaaaaaaa;
      sim.rpchip.core1.registers[1] = 0xbbbbbbbb;

      expect(decodeRegs(payload(server.processGDBMessage('g')))[1]).toBe(0xaaaaaaaa);

      server.processGDBMessage('Hg2');
      expect(decodeRegs(payload(server.processGDBMessage('g')))[1]).toBe(0xbbbbbbbb);
    });
  });

  // =====================================================================
  // Memory read/write
  // =====================================================================

  describe('memory access', () => {
    test('read memory (m)', () => {
      sim.rpchip.writeUint32(SCRATCH, 0xdeadbeef);
      const r = payload(server.processGDBMessage('m20000000,4'));
      expect(r).toBe('efbeadde'); // little-endian
    });

    test('write memory (M)', () => {
      server.processGDBMessage('M20000000,4:efbeadde');
      expect(sim.rpchip.readUint32(SCRATCH)).toBe(0xdeadbeef);
    });

    test('binary write memory (X)', () => {
      server.processGDBMessage('X20000000,4:\xef\xbe\xad\xde');
      expect(sim.rpchip.readUint32(SCRATCH)).toBe(0xdeadbeef);
    });

    test('binary write with escape sequences (X)', () => {
      // Escaped 0x7d ('}') and 0x23 ('#')
      server.processGDBMessage('X20000000,4:\x41\x7d\x5d\x7d\x03\x42');
      expect(sim.rpchip.readUint8(SCRATCH)).toBe(0x41);
      expect(sim.rpchip.readUint8(SCRATCH + 1)).toBe(0x7d);
      expect(sim.rpchip.readUint8(SCRATCH + 2)).toBe(0x23);
      expect(sim.rpchip.readUint8(SCRATCH + 3)).toBe(0x42);
    });

    test('read memory byte-by-byte', () => {
      sim.rpchip.writeUint8(SCRATCH, 0x01);
      sim.rpchip.writeUint8(SCRATCH + 1, 0x02);
      sim.rpchip.writeUint8(SCRATCH + 2, 0x03);
      sim.rpchip.writeUint8(SCRATCH + 3, 0x04);
      const r = payload(server.processGDBMessage('m20000000,4'));
      expect(r).toBe('01020304');
    });
  });

  // =====================================================================
  // Breakpoints
  // =====================================================================

  describe('breakpoints', () => {
    test('set software breakpoint (Z0)', () => {
      expect(payload(server.processGDBMessage('Z0,20000100,2'))).toBe('OK');
    });

    test('clear software breakpoint (z0)', () => {
      server.processGDBMessage('Z0,20000100,2');
      expect(payload(server.processGDBMessage('z0,20000100,2'))).toBe('OK');
    });

    test('set hardware breakpoint (Z1)', () => {
      expect(payload(server.processGDBMessage('Z1,20000200,2'))).toBe('OK');
    });

    test('clear hardware breakpoint (z1)', () => {
      server.processGDBMessage('Z1,20000200,2');
      expect(payload(server.processGDBMessage('z1,20000200,2'))).toBe('OK');
    });

    test('breakpoint triggers halt during execute', () => {
      // Load a simple loop: NOP + B .
      // NOP = 0x46c0 (MOV R8, R8), B . = 0xe7fe
      sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
      sim.rpchip.writeUint16(SCRATCH + 2, 0xe7fe); // B . (branch to self)
      // Thumb mode: PC has bit 0 clear, instructions at even addresses
      sim.rpchip.core0.PC = SCRATCH;
      sim.rpchip.core1.waiting = true;

      // Set breakpoint at SCRATCH+2
      server.processGDBMessage('Z0,20000002,2');

      server.execute();

      // The execute loop runs synchronously for the first batch.
      // NOP at SCRATCH, then PC=SCRATCH+2 matches breakpoint.
      expect(server.executing).toBe(false);
      expect(sim.rpchip.core0.PC).toBe(SCRATCH + 2);

      server.stop();
    });

    test('breakpoint on core 1 reports correct thread in stop reply', () => {
      // Core 0: simple loop at SCRATCH
      sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
      sim.rpchip.writeUint16(SCRATCH + 2, 0xe7fe); // B . (self)
      sim.rpchip.core0.PC = SCRATCH;

      // Core 1: simple loop at SCRATCH+0x100
      sim.rpchip.writeUint16(SCRATCH + 0x100, 0x46c0); // nop
      sim.rpchip.writeUint16(SCRATCH + 0x102, 0xe7fe); // B . (self)
      sim.rpchip.core1.PC = SCRATCH + 0x100;
      sim.rpchip.core1.waiting = false;

      // Breakpoint only on core 1's code
      server.processGDBMessage('Z0,20000102,2');

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
      expect(sim.rpchip.core1.PC).toBe(SCRATCH + 0x102);
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
      // NOP (MOV R8, R8) = 0x46c0, 2 bytes in Thumb
      sim.rpchip.writeUint16(SCRATCH, 0x46c0);
      sim.rpchip.core0.PC = SCRATCH;
      sim.rpchip.core1.waiting = true;

      const r = payload(server.processGDBMessage('vCont;s:1'));
      expect(r).toContain('T05');
      expect(r).toContain('thread:1');
      expect(sim.rpchip.core0.PC).toBe(SCRATCH + 2);
    });

    test('step core 1 does not advance core 0', () => {
      sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
      sim.rpchip.core0.PC = SCRATCH;
      sim.rpchip.core1.PC = SCRATCH;
      sim.rpchip.core1.waiting = false;

      const core0PcBefore = sim.rpchip.core0.PC;
      server.processGDBMessage('vCont;s:2');

      expect(sim.rpchip.core1.PC).toBe(SCRATCH + 2);
      expect(sim.rpchip.core0.PC).toBe(core0PcBefore);
    });

    test('step without thread ID uses current thread', () => {
      sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
      sim.rpchip.core0.PC = SCRATCH;

      server.processGDBMessage('Hg1');
      const r = payload(server.processGDBMessage('vCont;s'));
      expect(r).toContain('thread:1');
      expect(sim.rpchip.core0.PC).toBe(SCRATCH + 2);
    });

    test('step returns register dump for stepped core', () => {
      sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
      sim.rpchip.core0.PC = SCRATCH;
      sim.rpchip.core0.registers[3] = 0xcafef00d;

      const r = payload(server.processGDBMessage('vCont;s:1'));
      // T05 response contains register values: "03:0df0feca;..."
      expect(r).toContain('03:');
    });
  });

  // =====================================================================
  // vCont multi-action
  // =====================================================================

  describe('vCont multi-action', () => {
    test('vCont;c:1;c:2 continues both cores', () => {
      sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
      sim.rpchip.writeUint16(SCRATCH + 2, 0xe7fd); // B -6 (back to SCRATCH+2)
      sim.rpchip.core0.PC = SCRATCH;
      sim.rpchip.core1.PC = SCRATCH;
      sim.rpchip.core1.waiting = false;

      server.processGDBMessage('Z0,20000002,2');
      server.processGDBMessage('vCont;c:1;c:2');

      expect(server.executing).toBe(false);
      expect(sim.rpchip.core0.PC).toBe(SCRATCH + 2);
      server.stop();
    });

    test('vCont;c:1 continues only core 0', () => {
      sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
      sim.rpchip.core0.PC = SCRATCH;
      sim.rpchip.core1.PC = 0x20001000;
      sim.rpchip.core1.waiting = false;

      server.processGDBMessage('Z0,20000002,2');
      server.processGDBMessage('vCont;c:1');

      expect(server.executing).toBe(false);
      expect(sim.rpchip.core0.PC).toBe(SCRATCH + 2);
      expect(sim.rpchip.core1.PC).toBe(0x20001000);
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
  // BKPT instruction trap
  // =====================================================================

  describe('BKPT instruction trap', () => {
    test('BKPT on core 0 halts and notifies', () => {
      // The onBreak callback is wired by addConnection(); simulate it.
      let halted = false;
      server.addConnection({
        feedData() {},
        onBreakpoint() {
          halted = true;
        },
      } as any);

      // BKPT #0 = 0xbe00
      sim.rpchip.writeUint16(SCRATCH, 0xbe00);
      sim.rpchip.core0.PC = SCRATCH;
      sim.rpchip.core1.waiting = true;

      // Execute one instruction — BKPT should trigger onBreak
      sim.rpchip.currentCore = 0;
      sim.rpchip.core0.executeInstruction();

      // The onBreak callback in ArmGDBServer sets haltedCore and stops
      expect(server.executing).toBe(false);
      expect(halted).toBe(true);
      // breakRewind=2, so PC is rewound to the BKPT instruction
      expect(sim.rpchip.core0.PC).toBe(SCRATCH);
    });
  });

  // =====================================================================
  // Monitor commands (qRcmd)
  // =====================================================================

  describe('monitor commands', () => {
    function decodeMonitorOutput(response: string | void): string {
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
      expect(text).toContain('SM0');
    });

    test('monitor pio 1 dumps only PIO1', () => {
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('pio 1').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toContain('PIO1');
      expect(text).not.toContain('=== PIO0');
    });

    test('monitor pio shows SM state', () => {
      sim.rpchip.pio[0].machines[0].pc = 3;
      sim.rpchip.pio[0].machines[0].x = 0x99;
      sim.rpchip.pio[0].machines[0].inputShiftReg = 0xdeadbeef;
      sim.rpchip.pio[0].machines[0].inputShiftCount = 16;
      sim.rpchip.pio[0].machines[0].outputShiftReg = 0xcafef00d;
      sim.rpchip.pio[0].machines[0].outputShiftCount = 8;
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('pio 0').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toMatch(/pc=3/);
      expect(text).toMatch(/x=0x99/);
      expect(text).toMatch(/ISR=0xdeadbeef/);
      expect(text).toMatch(/OSR=0xcafef00d/);
      expect(text).toMatch(/16\/\d+ bits/);
      expect(text).toMatch(/8\/\d+ bits/);
    });

    test('monitor gpio dumps all pins', () => {
      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('gpio').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toContain('GPIO');
      expect(text).toContain('30 pins');
      expect(text).toContain('GP 0');
      expect(text).toContain('GP29');
    });

    test('monitor gpio shows pin function and values', () => {
      sim.rpchip.gpio[0].ctrl = 5; // FUNCTION_SIO
      sim.rpchip.gpio[0].padValue = 0;
      sim.rpchip.gpio[5].ctrl = 6; // FUNCTION_PIO0

      const resp = server.processGDBMessage('qRcmd,' + Buffer.from('gpio').toString('hex'));
      const text = decodeMonitorOutput(resp);
      expect(text).toMatch(/GP 0 SIO/);
      expect(text).toMatch(/GP 5 PIO0/);
      expect(text).toMatch(/inputs:/);
      expect(text).toMatch(/outputs:/);
    });
  });
});
