/*
 * GDB integration test — uses the real `gdb` binary to connect to the
 * ARM (Cortex-M0) GDB server over TCP. Verifies the full protocol stack
 * end-to-end. Mirrors the RISC-V integration test.
 *
 * Requires an ARM-capable `gdb` on $PATH. Skipped automatically if not found.
 */

import { describe, expect, test, beforeAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import { Simulator } from '../../simulator';
import { RP2040 } from '../../rp2040';
import { ArmGDBServer } from '../arm-gdb-server';
import { GDBTCPServer } from '../gdb-tcp-server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRATCH = 0x20000000;

// Check if an ARM-capable gdb is available on PATH.
// gdb-multiarch doesn't show target=arm in --configuration, so we check
// by running a batch command that sets the architecture.
const GDB_CANDIDATES = ['arm-none-eabi-gdb', 'gdb-multiarch', 'gdb'];

const GDB_BIN = (() => {
  const { execSync } = require('child_process');
  for (const candidate of GDB_CANDIDATES) {
    try {
      // Check that the binary exists and can set ARM architecture
      execSync(`${candidate} -batch -nx -ex "set architecture arm"`, { stdio: 'pipe' });
      return candidate;
    } catch {}
  }
  return null;
})();

const gdbAvailable = GDB_BIN !== null;

// Helper: run a GDB batch script against our server and capture output
async function runGdbSession(port: number, commands: string[]): Promise<string> {
  const script = commands.join('\n') + '\n';
  // Each invocation gets its own unique temp directory so parallel test
  // files / repeated calls cannot collide. mkdtempSync is atomic.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdb-test-'));
  const scriptFile = path.join(tmpDir, 'script.gdb');
  fs.writeFileSync(scriptFile, script);
  try {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(GDB_BIN!, ['-batch', '-nx', '-x', scriptFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`gdb exited ${code}\nstderr: ${stderr}`));
        } else {
          resolve(stdout + stderr);
        }
      });
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

describe.skipIf(!gdbAvailable)('ARM GDB integration (real gdb binary)', () => {
  let sim: Simulator<RP2040>;
  let gdbServer: GDBTCPServer;
  let armServer: ArmGDBServer;
  let port: number;

  beforeAll(() => {
    sim = new Simulator(new RP2040());
    sim.rpchip.core1.waiting = true;

    // Load a small program: NOP loop (Thumb)
    // MOV R8, R8 (NOP) = 0x46c0, B . = 0xe7fe
    sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
    sim.rpchip.writeUint16(SCRATCH + 2, 0xe7fe); // B . (branch to self)
    sim.rpchip.core0.PC = SCRATCH;

    armServer = new ArmGDBServer(sim);
    gdbServer = new GDBTCPServer(armServer, 0);
    const addr = (gdbServer as any).socketServer.address();
    port = addr.port;
  });

  beforeEach(() => {
    armServer.stop();
    armServer['breakpoints'].clear();
    armServer['singleCore'] = -1;
  });

  test('connect and read registers', async () => {
    sim.rpchip.core0.registers[1] = 0xdeadbeef;
    sim.rpchip.core0.PC = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'info registers',
      'detach',
    ]);

    expect(output).toContain('r1');
    expect(output).toMatch(/deadbeef/i);
  });

  test('read and write memory', async () => {
    sim.rpchip.writeUint32(SCRATCH, 0xcafef00d);

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'x/wx 0x20000000',
      'set *(unsigned int*)0x20000000 = 0x12345678',
      'x/wx 0x20000000',
      'detach',
    ]);

    expect(output).toContain('cafef00d');
    expect(output).toContain('12345678');
    expect(sim.rpchip.readUint32(SCRATCH)).toBe(0x12345678);
  });

  test('single-step and verify pc advance', async () => {
    // Restore NOP (previous test may have overwritten memory)
    sim.rpchip.writeUint16(SCRATCH, 0x46c0); // MOV R8, R8 (NOP, 2 bytes)
    sim.rpchip.core0.PC = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'stepi',
      'info registers pc',
      'detach',
    ]);

    // After one 2-byte NOP, pc should be SCRATCH+2
    if (!output.match(/20000002/i)) {
      throw new Error(`Expected pc=20000002, got output:\n${output}`);
    }
  });

  test('set breakpoint and continue', async () => {
    // NOP loop: NOP at SCRATCH, B . at SCRATCH+2
    sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
    sim.rpchip.writeUint16(SCRATCH + 2, 0xe7fe); // B . (branch to self)
    sim.rpchip.core0.PC = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'break *0x20000002',
      'continue',
      'info registers pc',
      'detach',
    ]);

    expect(output).toMatch(/Breakpoint 1/i);
    expect(output).toMatch(/20000002/i);
  });

  test('breakpoint hit, inspect, modify register, re-hit', async () => {
    // Program: increment r5 in a loop
    //   SCRATCH+0: MOVS R5, #0       ; r5 = 0        (0x2500)
    //   SCRATCH+2: ADDS R5, #1       ; r5 += 1       (0x3501)  <-- breakpoint
    //   SCRATCH+4: B   SCRATCH+2     ; loop back     (0xe7fd = B -6)
    sim.rpchip.writeUint16(SCRATCH, 0x2500); // MOVS R5, #0
    sim.rpchip.writeUint16(SCRATCH + 2, 0x3501); // ADDS R5, #1
    sim.rpchip.writeUint16(SCRATCH + 4, 0xe7fd); // B -6 (back to SCRATCH+2)
    sim.rpchip.core0.PC = SCRATCH;
    sim.rpchip.core0.registers[5] = 0;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      // Break at the increment instruction
      'break *0x20000002',
      // Continue: init runs (r5=0), then PC hits breakpoint at SCRATCH+2
      'continue',
      // r5 should be 0 (increment hasn't executed yet)
      'print/x $r5',
      // Continue: increment runs (r5=1), loop jumps back, breakpoint re-hits
      'continue',
      // r5 should now be 1
      'print/x $r5',
      // Modify r5 to 100
      'set $r5 = 100',
      // Continue: increment runs (r5=101), loop jumps back, breakpoint re-hits
      'continue',
      // r5 should be 101
      'print/x $r5',
      'detach',
    ]);

    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    if (!prints || prints.length < 3) {
      throw new Error(`GDB output:\n${output}`);
    }
    expect(prints![0]).toMatch(/0x0$/i); // first hit: r5 = 0
    if (!prints![1].match(/0x1$/i)) {
      throw new Error(`Expected r5=1 on second hit, got: ${prints![1]}\nFull output:\n${output}`);
    }
    expect(prints![2]).toMatch(/0x65$/i); // third hit: r5 = 101 (0x65)
  });

  test('breakpoint, step over, continue', async () => {
    // Program: two instructions then loop
    //   SCRATCH+0: MOVS R5, #42      ; r5 = 42       (0x252a)
    //   SCRATCH+2: ADDS R6, R5, #1   ; r6 = r5 + 1   (0x1c6e)  <-- breakpoint
    //   SCRATCH+4: B   SCRATCH+2     ; loop back     (0xe7fd)
    sim.rpchip.writeUint16(SCRATCH, 0x252a); // MOVS R5, #42
    sim.rpchip.writeUint16(SCRATCH + 2, 0x1c6e); // ADDS R6, R5, #1
    sim.rpchip.writeUint16(SCRATCH + 4, 0xe7fd); // B -6
    sim.rpchip.core0.PC = SCRATCH;
    sim.rpchip.core0.registers[5] = 0;
    sim.rpchip.core0.registers[6] = 0;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      // Break at the ADDS R6 instruction
      'break *0x20000002',
      // Continue: init runs, hit breakpoint at SCRATCH+2
      'continue',
      // r5 should be 42 (init ran), r6 should be 0 (not yet executed)
      'print/x $r5',
      'print/x $r6',
      // Single-step over the ADDS R6 instruction
      'stepi',
      // Now r6 should be 43, PC should be at SCRATCH+4
      'print/x $r6',
      'info registers pc',
      // Continue: B loops back to SCRATCH+2, breakpoint re-hits
      'continue',
      // r5 should still be 42, r6 should be 43
      'print/x $r5',
      'print/x $r6',
      'detach',
    ]);

    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    expect(prints).not.toBeNull();
    expect(prints![0]).toMatch(/0x2a$/i); // r5 = 42
    expect(prints![1]).toMatch(/0x0$/i); // r6 = 0 (before stepi)
    expect(prints![2]).toMatch(/0x2b$/i); // r6 = 43 (after stepi)
    expect(output).toMatch(/20000004/i); // PC at SCRATCH+4 after stepi
    expect(prints![3]).toMatch(/0x2a$/i); // r5 still 42
    expect(prints![4]).toMatch(/0x2b$/i); // r6 still 43
  });

  test('switch to core 1 and read/write registers', async () => {
    sim.rpchip.core1.waiting = false;
    sim.rpchip.core0.registers[5] = 0x11111111;
    sim.rpchip.core1.registers[5] = 0x22222222;
    // Park both cores so continue/step don't interfere
    sim.rpchip.core0.waiting = true;
    sim.rpchip.core1.waiting = true;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'thread 1',
      'print/x $r5',
      'thread 2',
      'print/x $r5',
      'set $r5 = 0xdeadbeef',
      'print/x $r5',
      'detach',
    ]);

    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    if (!prints || prints.length < 3) {
      throw new Error(`GDB output:\n${output}`);
    }
    expect(prints![0]).toMatch(/0x11111111/i); // core 0 r5
    expect(prints![1]).toMatch(/0x22222222/i); // core 1 r5
    expect(prints![2]).toMatch(/0xdeadbeef/i); // core 1 r5 after write
    expect(sim.rpchip.core1.registers[5]).toBe(0xdeadbeef);
    expect(sim.rpchip.core0.registers[5]).toBe(0x11111111);
  });

  test('single-step core 1 independently', async () => {
    sim.rpchip.core1.waiting = false;
    sim.rpchip.core0.waiting = true;
    sim.rpchip.writeUint16(SCRATCH, 0x46c0); // nop
    const core0Pc = sim.rpchip.core0.PC;
    sim.rpchip.core1.PC = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'thread 2',
      'stepi',
      'info registers pc',
      'detach',
    ]);

    // Core 1 should have advanced by 2 (Thumb NOP)
    expect(sim.rpchip.core1.PC).toBe(SCRATCH + 2);
    // Core 0 should not have moved
    expect(sim.rpchip.core0.PC).toBe(core0Pc);
  });

  test('breakpoint on core 1 while both cores run', async () => {
    // Both cores run loops at different addresses
    // Core 0: loop at SCRATCH (0x20000000)
    // Core 1: loop at SCRATCH+0x100 (0x20000100)
    sim.rpchip.core1.waiting = false;
    sim.rpchip.core0.waiting = false;

    // Core 0 program: ADDS R5, #1 then B .
    sim.rpchip.writeUint16(SCRATCH, 0x3501); // ADDS R5, #1
    sim.rpchip.writeUint16(SCRATCH + 2, 0xe7fd); // B -6
    sim.rpchip.core0.PC = SCRATCH;
    sim.rpchip.core0.registers[5] = 0;

    // Core 1 program: ADDS R6, #1 then B .
    sim.rpchip.writeUint16(SCRATCH + 0x100, 0x3601); // ADDS R6, #1
    sim.rpchip.writeUint16(SCRATCH + 0x102, 0xe7fd); // B -6
    sim.rpchip.core1.PC = SCRATCH + 0x100;
    sim.rpchip.core1.registers[6] = 0;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      // Break at core 1's increment instruction
      'break *0x20000100',
      // Continue all cores
      'continue',
      // Should hit the breakpoint on core 1
      'info registers pc',
      // Switch to thread 2 and read r6
      'thread 2',
      'print/x $r6',
      'detach',
    ]);

    expect(output).toMatch(/20000100/i);
    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    expect(prints).not.toBeNull();
    const r6val = parseInt(prints![0].match(/0x([0-9a-f]+)/i)![1], 16);
    expect(r6val).toBeGreaterThanOrEqual(1);
  });
});
