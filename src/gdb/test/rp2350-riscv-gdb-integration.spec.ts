/*
 * GDB integration test — uses the real `gdb` binary to connect to the
 * RISC-V GDB server over TCP. Verifies the full protocol stack end-to-end.
 *
 * Requires `gdb` on $PATH. Skipped automatically if not found.
 */

import { describe, expect, test, beforeAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import { RP2350 } from '../../rp2350';
import { RISCVGDBServer } from '../riscv-gdb-server';
import { GDBTCPServer } from '../gdb-tcp-server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRATCH = 0x20000000;

// Check if a RISC-V-capable gdb is available on PATH.
// Tests whether the binary can execute "set architecture riscv".
// gdb-multiarch defaults to rv64, so we track whether an explicit rv32
// arch flag is needed.
const GDB_CANDIDATES = [
  'riscv32-unknown-elf-gdb',
  'riscv64-unknown-elf-gdb',
  'riscv32-corev-elf-gdb',
  'riscv64-corev-elf-gdb',
  'gdb-multiarch',
  'gdb',
];

const { GDB_BIN, GDB_ARCH_PREFIX } = (() => {
  const { execSync } = require('child_process');
  for (const candidate of GDB_CANDIDATES) {
    try {
      execSync(`${candidate} -batch -nx -ex "set architecture riscv"`, { stdio: 'pipe' });
      // Dedicated riscv32 binaries default to rv32; others need explicit arch
      const isRiscv32 = /^riscv32/.test(candidate);
      return {
        GDB_BIN: candidate,
        GDB_ARCH_PREFIX: isRiscv32 ? '' : 'set architecture riscv:rv32\n',
      };
    } catch {}
  }
  return { GDB_BIN: null, GDB_ARCH_PREFIX: '' };
})();

const gdbAvailable = GDB_BIN !== null;

// Helper: run a GDB batch script against our server and capture output
async function runGdbSession(port: number, commands: string[]): Promise<string> {
  const script = GDB_ARCH_PREFIX + commands.join('\n') + '\n';
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

describe.skipIf(!gdbAvailable)('GDB integration (real gdb binary)', () => {
  let chip: RP2350;
  let gdbServer: GDBTCPServer;
  let riscvServer: RISCVGDBServer;
  let port: number;
  beforeAll(() => {
    chip = new RP2350();
    chip.core1.waiting = true;

    // Load a small program: NOP loop
    chip.writeUint32(SCRATCH, 0x00000013); // nop
    chip.writeUint32(SCRATCH + 4, 0x00000013); // nop
    chip.writeUint32(SCRATCH + 8, 0xff5ff06f); // j SCRATCH
    chip.core0.pc = SCRATCH;

    riscvServer = new RISCVGDBServer(chip);
    // Pick a random free port
    gdbServer = new GDBTCPServer(riscvServer, 0);
    // The server doesn't expose the assigned port yet; read it from the address
    const addr = (gdbServer as any).socketServer.address();
    port = addr.port;
  });

  beforeEach(() => {
    // Ensure the server is fully stopped before each test
    riscvServer.stop();
    riscvServer['breakpoints'].clear();
    riscvServer['singleCore'] = -1;
  });

  test('connect and read registers', async () => {
    chip.core0.setRegisterU(1, 0xdeadbeef);
    chip.core0.pc = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'info registers',
      'detach',
    ]);

    // GDB should show x1/ra with the value we set (in hex)
    expect(output).toContain('ra');
    expect(output).toMatch(/deadbeef/i);
  });

  test('read and write memory', async () => {
    chip.writeUint32(SCRATCH, 0xcafef00d);

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'x/wx 0x20000000',
      'set *(unsigned int*)0x20000000 = 0x12345678',
      'x/wx 0x20000000',
      'detach',
    ]);

    expect(output).toContain('cafef00d');
    expect(output).toContain('12345678');
    expect(chip.readUint32(SCRATCH)).toBe(0x12345678);
  });

  test('single-step and verify pc advance', async () => {
    // Restore the NOP program (previous test may have overwritten memory)
    chip.writeUint32(SCRATCH, 0x00000013); // nop
    chip.core0.pc = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'stepi',
      'info registers pc',
      'detach',
    ]);

    // After one 32-bit NOP, pc should be SCRATCH+4
    if (!output.match(/20000004/i)) {
      throw new Error(`Expected pc=20000004, got output:\n${output}`);
    }
  });

  test('set breakpoint and continue', async () => {
    // Restore the NOP loop program
    chip.writeUint32(SCRATCH, 0x00000013); // nop
    chip.writeUint32(SCRATCH + 4, 0x00000013); // nop
    chip.writeUint32(SCRATCH + 8, 0xff5ff06f); // j SCRATCH
    chip.core0.pc = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'break *0x20000008',
      'continue',
      'info registers pc',
      'detach',
    ]);

    expect(output).toMatch(/Breakpoint 1/i);
    expect(output).toMatch(/20000008/i);
  });

  test('breakpoint hit, inspect, modify register, re-hit', async () => {
    // Program: increment x5 in a loop
    //   SCRATCH+0: addi x5, x0, 0       ; x5 = 0
    //   SCRATCH+4: addi x5, x5, 1       ; x5 += 1  <-- breakpoint here
    //   SCRATCH+8: j   SCRATCH+4        ; loop back (offset -4)
    chip.writeUint32(SCRATCH, 0x00000293); // addi x5, x0, 0
    chip.writeUint32(SCRATCH + 4, 0x00128293); // addi x5, x5, 1
    chip.writeUint32(SCRATCH + 8, 0xffdff06f); // j -4 (back to SCRATCH+4)
    chip.core0.pc = SCRATCH;
    chip.core0.setRegisterU(5, 0);

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      // Break at the increment instruction
      'break *0x20000004',
      // Continue: init runs (x5=0), then PC hits breakpoint at SCRATCH+4
      'continue',
      // x5 should be 0 (increment hasn't executed yet)
      'print/x $x5',
      // Continue: increment runs (x5=1), loop jumps back, breakpoint re-hits
      'continue',
      // x5 should now be 1
      'print/x $x5',
      // Modify x5 to 100
      'set $x5 = 100',
      // Continue: increment runs (x5=101), loop jumps back, breakpoint re-hits
      'continue',
      // x5 should be 101
      'print/x $x5',
      'detach',
    ]);

    // GDB print output lines look like: "$1 = 0x0" / "$2 = 0x1" / "$3 = 0x65"
    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    expect(prints).not.toBeNull();
    expect(prints![0]).toMatch(/0x0$/i); // first hit: x5 = 0
    expect(prints![1]).toMatch(/0x1$/i); // second hit: x5 = 1
    expect(prints![2]).toMatch(/0x65$/i); // third hit: x5 = 101 (0x65)
  });

  test('breakpoint, step over, continue', async () => {
    // Program: two instructions then loop
    //   SCRATCH+0: addi x5, x0, 42      ; x5 = 42
    //   SCRATCH+4: addi x6, x5, 1       ; x6 = x5 + 1
    //   SCRATCH+8: j   SCRATCH+4        ; loop (offset -4)
    chip.writeUint32(SCRATCH, 0x02a00293); // addi x5, x0, 42
    chip.writeUint32(SCRATCH + 4, 0x00128313); // addi x6, x5, 1
    chip.writeUint32(SCRATCH + 8, 0xffdff06f); // j -4
    chip.core0.pc = SCRATCH;
    chip.core0.setRegisterU(5, 0);
    chip.core0.setRegisterU(6, 0);

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      // Break at the addi x6 instruction
      'break *0x20000004',
      // Continue: init runs, hit breakpoint at SCRATCH+4
      'continue',
      // x5 should be 42 (init ran), x6 should be 0 (not yet executed)
      'print/x $x5',
      'print/x $x6',
      // Single-step over the addi x6 instruction
      'stepi',
      // Now x6 should be 43, PC should be at SCRATCH+8
      'print/x $x6',
      'info registers pc',
      // Continue: j loops back to SCRATCH+4, breakpoint re-hits
      'continue',
      // x5 should still be 42, x6 should be 43 (from previous step)
      'print/x $x5',
      'print/x $x6',
      'detach',
    ]);

    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    expect(prints).not.toBeNull();
    expect(prints![0]).toMatch(/0x2a$/i); // x5 = 42
    expect(prints![1]).toMatch(/0x0$/i); // x6 = 0 (before stepi)
    expect(prints![2]).toMatch(/0x2b$/i); // x6 = 43 (after stepi)
    expect(output).toMatch(/20000008/i); // PC at SCRATCH+8 after stepi
    expect(prints![3]).toMatch(/0x2a$/i); // x5 still 42 after continue
    expect(prints![4]).toMatch(/0x2b$/i); // x6 still 43 (j didn't change it)
  });

  test('switch to core 1 and read/write registers', async () => {
    // Unpark core1 and give it a distinct register state
    chip.core1.waiting = false;
    chip.core0.setRegisterU(5, 0x11111111);
    chip.core1.setRegisterU(5, 0x22222222);
    // Park both cores so continue/step don't interfere
    chip.core0.waiting = true;
    chip.core1.waiting = true;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      'thread 1',
      'print/x $x5',
      'thread 2',
      'print/x $x5',
      'set $x5 = 0xdeadbeef',
      'print/x $x5',
      'detach',
    ]);

    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    if (!prints || prints.length < 3) {
      throw new Error(`GDB output:\n${output}`);
    }
    expect(prints![0]).toMatch(/0x11111111/i); // core 0 x5
    expect(prints![1]).toMatch(/0x22222222/i); // core 1 x5
    expect(prints![2]).toMatch(/0xdeadbeef/i); // core 1 x5 after write
    // Verify the write reached the emulator
    expect(chip.core1.getRegisterU(5)).toBe(0xdeadbeef);
    // Core 0 should be untouched
    expect(chip.core0.getRegisterU(5)).toBe(0x11111111);
  });

  test('single-step core 1 independently', async () => {
    // NOP loop so GDB's stepi dance (set bp at next instr, continue, etc.)
    // doesn't hit illegal instructions at zeroed memory.
    chip.core1.waiting = false;
    chip.core0.waiting = true;
    chip.writeUint32(SCRATCH, 0x00000013); // nop
    chip.writeUint32(SCRATCH + 4, 0x00000013); // nop
    chip.writeUint32(SCRATCH + 8, 0xffdff06f); // j -4
    const core0Pc = chip.core0.pc;
    chip.core1.pc = SCRATCH;

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      // Select thread 2 (core 1)
      'thread 2',
      // Step core 1 only
      'stepi',
      'info registers pc',
      'detach',
    ]);

    // Core 1 should have advanced by 4 (32-bit NOP)
    expect(chip.core1.pc).toBe(SCRATCH + 4);
    // Core 0 should not have moved
    expect(chip.core0.pc).toBe(core0Pc);
  });

  test('breakpoint on core 1 while both cores run', async () => {
    // Both cores run the same loop at different addresses
    // Core 0: loop at SCRATCH (0x20000000)
    // Core 1: loop at SCRATCH+0x100 (0x20000100)
    chip.core1.waiting = false;
    chip.core0.waiting = false;

    // Core 0 program: addi x5, x5, 1 then j back
    chip.writeUint32(SCRATCH, 0x00128293); // addi x5, x5, 1
    chip.writeUint32(SCRATCH + 4, 0xffdff06f); // j -4
    chip.core0.pc = SCRATCH;
    chip.core0.setRegisterU(5, 0);

    // Core 1 program: addi x6, x6, 1 then j back
    chip.writeUint32(SCRATCH + 0x100, 0x00130313); // addi x6, x6, 1
    chip.writeUint32(SCRATCH + 0x104, 0xffdff06f); // j -4
    chip.core1.pc = SCRATCH + 0x100;
    chip.core1.setRegisterU(6, 0);

    const output = await runGdbSession(port, [
      `target remote :${port}`,
      // Break at core 1's increment instruction
      'break *0x20000100',
      // Continue all cores
      'continue',
      // Should hit the breakpoint on core 1
      'info registers pc',
      // Switch to thread 2 and read x6
      'thread 2',
      'print/x $x6',
      'detach',
    ]);

    // Should have stopped at the core 1 breakpoint address
    expect(output).toMatch(/20000100/i);
    // x6 should be >= 1 (core 1 ran at least one increment before hitting bp)
    const prints = output.match(/\$\d+ = 0x[0-9a-f]+/gi);
    expect(prints).not.toBeNull();
    const x6val = parseInt(prints![0].match(/0x([0-9a-f]+)/i)![1], 16);
    expect(x6val).toBeGreaterThanOrEqual(1);
  });
});
