/**
 * MicroPython execution tracer (ARM Cortex-M33 or RISC-V/Hazard3 cores).
 *
 * Boots a UF2 image through the real RP2350 bootrom (mirrors
 * `demo/rp2350-micropython-run.ts`'s boot sequence), then records a
 * per-instruction execution trace for one
 * core over a configurable instruction window. The trace is dumped (oldest
 * first, most recent last) when the window ends (`stopAtInstructionNumber`),
 * a total step budget is exhausted (`maxSteps` — for inspecting a hang that
 * never completes the window), or the emulator crashes — whichever happens
 * first.
 *
 * RISC-V disassembly uses `riscv32-corev-elf-objdump` (or an equivalent
 * riscv32 objdump) on $PATH by default; ARM disassembly uses
 * `arm-none-eabi-objdump`. Override either with
 * DEBUG_TRACE_RISCV_OBJDUMP / DEBUG_TRACE_ARM_OBJDUMP (path or bare name).
 *
 * Usage: `npx tsx demo/debug_tracing.ts`, configured either by editing the
 * consts below or via environment variables (env wins when set):
 *   DEBUG_TRACE_ARCH            'arm' or 'riscv'
 *   DEBUG_TRACE_CORE            traceCoreNumber (0 or 1)
 *   DEBUG_TRACE_START           traceStartInstructionNumber
 *   DEBUG_TRACE_STOP            stopAtInstructionNumber ("Infinity" ok)
 *   DEBUG_TRACE_MAX_STEPS       maxSteps ("Infinity" ok)
 *   DEBUG_TRACE_IMAGE           imagePath
 *   DEBUG_TRACE_MAX_ENTRIES     maxTraceEntries
 *   DEBUG_TRACE_AUTO_REPL       autoReplInput (\r and \n escapes supported)
 *   DEBUG_TRACE_WATCH_VALUES    comma-separated hex/decimal words
 *   DEBUG_TRACE_WATCH_ADDRESSES comma-separated hex/decimal addresses
 *   DEBUG_TRACE_WATCH_IRQS      comma-separated IRQ numbers (RISC-V only)
 *   DEBUG_TRACE_WATCH_PC        comma-separated hex/decimal PCs
 *   DEBUG_TRACE_START_AT_PC     hex/decimal address
 *   DEBUG_TRACE_LENGTH_AFTER_PC instruction count
 *   DEBUG_TRACE_START_AT_SETUP_CALL  1-indexed sendSetupPacket() call number
 *   DEBUG_TRACE_RISCV_OBJDUMP   riscv32 objdump path/name (default riscv32-corev-elf-objdump)
 *   DEBUG_TRACE_ARM_OBJDUMP     ARM objdump path/name (default arm-none-eabi-objdump)
 * Type into the REPL over stdin as usual; the trace records silently in the
 * background until it's dumped.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RP2350, CoreArch } from '../src';
import { ICpuCore } from '../src/cpu-core';
import { CPU as RiscvCore } from '../src/riscv/cpu';
import { CortexM33Core } from '../src/cortex-m33/core';
import { isThumb32 } from '../src/cortex-m33/execute-thumb32';
import { USBCDC } from '../src/usb/cdc';
import { ConsoleLogger, LogLevel } from '../src/utils/logging';

const RISCV_OBJDUMP = process.env['DEBUG_TRACE_RISCV_OBJDUMP'] || 'riscv32-corev-elf-objdump';
const ARM_OBJDUMP = process.env['DEBUG_TRACE_ARM_OBJDUMP'] || 'arm-none-eabi-objdump';

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  if (v === 'Infinity') return Infinity;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name}=${v} is not a number`);
  return n;
}
function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envStrOrNull(name: string, def: string | null): string | null {
  const v = process.env[name];
  if (v === undefined) return def;
  return v.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
}
function envNumList(name: string, def: number[]): number[] {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v.split(',').map((s) => {
    const t = s.trim();
    const n = t.startsWith('0x') ? parseInt(t, 16) : Number(t);
    if (Number.isNaN(n)) throw new Error(`${name}: "${t}" is not a number`);
    return n;
  });
}

// ---- Config (env vars above override these defaults) ----

/** Which core architecture to emulate/trace. */
const coreArch: CoreArch = envStr('DEBUG_TRACE_ARCH', 'riscv') as CoreArch;
if (coreArch !== 'arm' && coreArch !== 'riscv') {
  throw new Error(`DEBUG_TRACE_ARCH=${coreArch} must be "arm" or "riscv"`);
}
/** Which core to trace: 0 or 1. */
const traceCoreNumber = envNum('DEBUG_TRACE_CORE', 0);
/** Start recording once this core has executed this many instructions. */
const traceStartInstructionNumber = envNum('DEBUG_TRACE_START', 0);
/** Stop and dump once the traced core reaches this instruction number
 * (in addition to dumping immediately on a crash). */
const stopAtInstructionNumber = envNum('DEBUG_TRACE_STOP', Infinity);
/** If set (hex or decimal), start recording the moment the traced core's PC
 * reaches this address, instead of by absolute instruction count. Useful
 * when instruction counts aren't stable across runs (e.g. real-time-based
 * alarm scheduling) but a specific landmark function/address is. Takes
 * priority over traceStartInstructionNumber when set. */
const traceStartAtPc: number | null = (() => {
  const v = process.env['DEBUG_TRACE_START_AT_PC'];
  if (v === undefined || v === '') return null;
  return (v.startsWith('0x') ? parseInt(v, 16) : Number(v)) >>> 0;
})();
/** Once traceStartAtPc triggers, keep recording for this many instructions
 * (still capped by maxTraceEntries/stopAtInstructionNumber). */
const traceLengthAfterPc = envNum('DEBUG_TRACE_LENGTH_AFTER_PC', 500);
/** If set, start recording the moment `usbCtrl.sendSetupPacket()` is called
 * for the Nth time (1-indexed) — deterministic across runs (triggered by our
 * own host-side code), unlike PC-based triggers on functions called
 * repeatedly for different reasons. Takes priority over traceStartAtPc. */
const traceStartAtSetupCall = envNum('DEBUG_TRACE_START_AT_SETUP_CALL', 0) || null;
/** Total mcu.step() budget. When exhausted without otherwise stopping, dumps
 * whatever trace was recorded plus current core/watchdog status — use this
 * to inspect a hang that never reaches stopAtInstructionNumber or a crash. */
const maxSteps = envNum('DEBUG_TRACE_MAX_STEPS', Infinity);
/** UF2 image to boot. */
const imagePath = envStr(
  'DEBUG_TRACE_IMAGE',
  coreArch === 'arm'
    ? './demo/RP2_Micropython_M33.uf2'
    : './demo/RPI_PICO2-RISCV-20260406-v1.28.0.uf2',
);
/** Safety cap on trace length so a forgotten stop point can't OOM the process. */
const maxTraceEntries = envNum('DEBUG_TRACE_MAX_ENTRIES', 500_000);
/** If set, automatically typed into the REPL (incl. Enter) once ">>>" first
 * appears in its output — useful for scripted/non-interactive repros. Set to
 * `null` to type into the REPL manually over stdin instead. */
const autoReplInput: string | null = envStrOrNull('DEBUG_TRACE_AUTO_REPL', null);
/** Memory-write watchpoint: log every 32-bit store (from either core, any
 * peripheral/RAM address) whose *value* matches one of these words, with the
 * writing core's instruction number, its current PC, and the destination
 * address. Empty array disables watching (zero overhead). */
const watchWriteValues: number[] = envNumList('DEBUG_TRACE_WATCH_VALUES', []);
/** Memory-write watchpoint: log every store (32/16/8-bit, either core) that
 * touches one of these addresses, regardless of what value is written.
 * Empty array disables watching (zero overhead). */
const watchWriteAddresses: number[] = envNumList('DEBUG_TRACE_WATCH_ADDRESSES', []);
/** Log every `chip.setInterrupt(irq, value)` call for these IRQ numbers (see
 * src/irq_rp2350.ts), from either core. RISC-V only — ARM interrupt state
 * lives in the per-core NVIC instead. Empty array disables watching. */
const watchIrqs: number[] = envNumList('DEBUG_TRACE_WATCH_IRQS', []);
/** Log (with a0-a2/r0-r2 register context) whenever the traced core's PC
 * reaches one of these addresses — useful for confirming a specific function
 * is (or isn't) ever called, e.g. checked against a .dis symbol table. Empty
 * array disables watching. */
const watchPcs: number[] = envNumList('DEBUG_TRACE_WATCH_PC', []);

// ---- Boot the chip, same sequence as demo/rp2350-micropython-run.ts ----

const mcu = new RP2350({ coreArch, loadFirmware: imagePath });
mcu.logger = new ConsoleLogger(LogLevel.Error);

mcu.uart[0].onByte = (value: number) => {
  process.stdout.write(new Uint8Array([value]));
};


const core0 = mcu.core[0];
const core1 = mcu.core[1];

/** Set (to the traced core's current instrNum) once `traceStartAtSetupCall`
 * sendSetupPacket() calls have happened. instrumentCore() reads this. */
let setupTriggerHitAt: number | null = null;
if (traceStartAtSetupCall !== null) {
  let setupCallCount = 0;
  const origSendSetupPacket = mcu.usbCtrl.sendSetupPacket.bind(mcu.usbCtrl);
  mcu.usbCtrl.sendSetupPacket = (setupPacket: Uint8Array) => {
    setupCallCount++;
    console.log(
      `[setup] sendSetupPacket call #${setupCallCount} at instr #${currentInstrNum}: ` +
        `${Array.from(setupPacket.slice(0, 8))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')}`,
    );
    if (setupCallCount === traceStartAtSetupCall && setupTriggerHitAt === null) {
      setupTriggerHitAt = currentInstrNum;
    }
    return origSendSetupPacket(setupPacket);
  };
}

let watchdogFireCount = 0;
const origWatchdogTrigger = mcu.watchdog.onWatchdogTrigger;
mcu.watchdog.onWatchdogTrigger = () => {
  watchdogFireCount++;
  console.log(`[watchdog] fire #${watchdogFireCount} at instr #${currentInstrNum}`);
  origWatchdogTrigger();
};

if (watchIrqs.length > 0) {
  if (coreArch !== 'riscv') {
    console.error('DEBUG_TRACE_WATCH_IRQS is only supported for coreArch=riscv; ignoring.');
  } else {
    const wanted = new Set(watchIrqs);
    const riscv0 = core0 as RiscvCore;
    const riscv1 = core1 as RiscvCore;
    const origSetInterrupt = mcu.setInterrupt.bind(mcu);
    mcu.setInterrupt = (irq: number, value: boolean) => {
      if (wanted.has(irq)) {
        console.log(
          `[irq] setInterrupt(${irq}, ${value}) at instr #${currentInstrNum}: ` +
            `core0(meiea=${riscv0.meiea[irq]}, waiting=${riscv0.waiting}) ` +
            `core1(meiea=${riscv1.meiea[irq]}, waiting=${riscv1.waiting})`,
        );
      }
      return origSetInterrupt(irq, value);
    };
  }
}

if (watchWriteValues.length > 0) {
  const wanted = new Set(watchWriteValues.map((v) => v >>> 0));
  const origWriteUint32 = mcu.writeUint32.bind(mcu);
  mcu.writeUint32 = (address: number, value: number) => {
    if (wanted.has(value >>> 0)) {
      const core = mcu.currentCore === 0 ? core0 : core1;
      const instrSuffix = mcu.currentCore === traceCoreNumber ? `, instr #${currentInstrNum}` : '';
      console.log(
        `[watch] core${mcu.currentCore} wrote 0x${(value >>> 0).toString(16)} to address ` +
          `0x${(address >>> 0).toString(16)} at PC=0x${(core.PC >>> 0).toString(16)}${instrSuffix}`,
      );
    }
    return origWriteUint32(address, value);
  };
}

if (watchWriteAddresses.length > 0) {
  const wanted = new Set(watchWriteAddresses.map((a) => a >>> 0));
  const logHit = (width: number, address: number, value: number) => {
    const core = mcu.currentCore === 0 ? core0 : core1;
    const instrSuffix = mcu.currentCore === traceCoreNumber ? `, instr #${currentInstrNum}` : '';
    console.log(
      `[watch] core${mcu.currentCore} wrote ${width}-bit value 0x${(value >>> 0).toString(
        16,
      )} to address ` +
        `0x${(address >>> 0).toString(16)} at PC=0x${(core.PC >>> 0).toString(16)}${instrSuffix}`,
    );
  };
  const origWriteUint32b = mcu.writeUint32.bind(mcu);
  mcu.writeUint32 = (address: number, value: number) => {
    const a = address >>> 0;
    if (
      wanted.has(a) ||
      wanted.has((a + 1) >>> 0) ||
      wanted.has((a + 2) >>> 0) ||
      wanted.has((a + 3) >>> 0)
    ) {
      logHit(32, a, value);
    }
    return origWriteUint32b(address, value);
  };
  const origWriteUint16 = mcu.writeUint16.bind(mcu);
  mcu.writeUint16 = (address: number, value: number) => {
    const a = address >>> 0;
    if (wanted.has(a) || wanted.has((a + 1) >>> 0)) {
      logHit(16, a, value);
    }
    return origWriteUint16(address, value);
  };
  const origWriteUint8 = mcu.writeUint8.bind(mcu);
  mcu.writeUint8 = (address: number, value: number) => {
    const a = address >>> 0;
    if (wanted.has(a)) {
      logHit(8, a, value);
    }
    return origWriteUint8(address, value);
  };
}

const cdc = new USBCDC(mcu.usbCtrl);
let replOutput = '';
let autoReplInputSent = false;
cdc.onSerialData = (value: Uint8Array, length: number) => {
  process.stdout.write(value.subarray(0, length));
  if (autoReplInput !== null && !autoReplInputSent) {
    replOutput += Buffer.from(value.subarray(0, length)).toString('latin1');
    if (replOutput.includes('>>>')) {
      autoReplInputSent = true;
      for (const ch of autoReplInput) cdc.sendSerialByte(ch.charCodeAt(0));
    }
  }
};
cdc.onDeviceConnected = () => {
  cdc.sendSerialByte('\r'.charCodeAt(0));
  cdc.sendSerialByte('\n'.charCodeAt(0));
};
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.on('data', (chunk) => {
  if (chunk[0] === 24) {
    // Ctrl+X
    process.exit(0);
  }
  for (const byte of chunk) {
    cdc.sendSerialByte(byte);
  }
});

// ---- Tracing ----

interface TraceEntry {
  instrNum: number;
  core: number;
  pc: number;
  hw0: number;
  hw1: number; // meaningful only when wide
  wide: boolean;
  regs: number[]; // RISC-V: x0-x31; ARM: r0-r12, sp, lr
  flags?: string; // ARM NZCV; undefined for RISC-V
}

const traceEntries: TraceEntry[] = [];
let tracingDone = false;
let stopReason = '';
/** Updated on every instruction the traced core executes, regardless of
 * whether we're inside the trace window yet — lets the crash handler report
 * "how far did we get" even if traceStartInstructionNumber was set too high. */
let currentInstrNum = -1;

/** Snapshot the traced core's registers, architecture-specific. */
function captureRegs(core: ICpuCore): { regs: number[]; flags?: string } {
  if (coreArch === 'riscv') {
    const c = core as RiscvCore;
    const x = new Array<number>(32);
    x[0] = 0;
    for (let i = 1; i < 32; i++) x[i] = c.registerSet.getRegisterU(i);
    return { regs: x };
  } else {
    const c = core as CortexM33Core;
    const regs = [...Array.from(c.regs.r.slice(0, 13)), c.regs.sp >>> 0, c.regs.lr >>> 0];
    const flags = `${c.regs.N ? 'N' : '-'}${c.regs.Z ? 'Z' : '-'}${c.regs.C ? 'C' : '-'}${
      c.regs.V ? 'V' : '-'
    }`;
    return { regs, flags };
  }
}

function instrumentCore(core: ICpuCore, coreIndex: number) {
  let instrCount = 0;
  let pcTriggerHitAt: number | null = null;
  const deferredMode = traceStartAtSetupCall !== null || traceStartAtPc !== null;
  const orig = core.executeInstruction.bind(core);
  core.executeInstruction = (): number => {
    const n = instrCount++;
    currentInstrNum = n;
    if (traceStartAtPc !== null && pcTriggerHitAt === null && core.PC >>> 0 === traceStartAtPc) {
      pcTriggerHitAt = n;
    }
    // setupTriggerHitAt (module-level) is set externally by the wrapped
    // sendSetupPacket() when traceStartAtSetupCall is configured; it takes
    // priority over the PC trigger when both are set.
    const triggerHitAt = traceStartAtSetupCall !== null ? setupTriggerHitAt : pcTriggerHitAt;
    const inWindow = deferredMode
      ? triggerHitAt !== null && n < triggerHitAt + traceLengthAfterPc
      : n >= traceStartInstructionNumber;
    if (!tracingDone && inWindow) {
      const pc = coreArch === 'arm' ? (core.PC >>> 0) & ~1 : core.PC >>> 0;
      const hw0 = mcu.readUint16(pc);
      const wide = coreArch === 'arm' ? isThumb32(hw0) : (hw0 & 3) === 3;
      const hw1 = wide ? mcu.readUint16((pc + 2) >>> 0) : 0;
      const { regs, flags } = captureRegs(core);
      traceEntries.push({
        instrNum: n,
        core: coreIndex,
        pc,
        hw0,
        hw1,
        wide,
        regs,
        flags,
      });
      if (traceEntries.length > maxTraceEntries) {
        tracingDone = true;
        stopReason = `hit the ${maxTraceEntries}-entry safety cap (maxTraceEntries) — raise it or narrow the trace window`;
      } else if (
        deferredMode &&
        triggerHitAt !== null &&
        n >= triggerHitAt + traceLengthAfterPc - 1
      ) {
        tracingDone = true;
        stopReason = `core ${coreIndex} recorded ${traceLengthAfterPc} instructions after the configured trigger`;
      } else if (!deferredMode && n >= stopAtInstructionNumber) {
        tracingDone = true;
        stopReason = `core ${coreIndex} reached instruction ${n} (stopAtInstructionNumber=${stopAtInstructionNumber})`;
      }
    }
    return orig();
  };
}

const tracedCore = traceCoreNumber === 0 ? core0 : core1;
instrumentCore(tracedCore, traceCoreNumber);

if (watchPcs.length > 0) {
  const wanted = new Set(watchPcs.map((a) => a >>> 0));
  for (const [i, c] of [core0, core1].entries()) {
    const orig = c.executeInstruction.bind(c);
    c.executeInstruction = (): number => {
      const pc = coreArch === 'arm' ? c.PC & ~1 : c.PC >>> 0;
      if (wanted.has(pc)) {
        const { regs } = captureRegs(c);
        const [a0, a1, a2] =
          coreArch === 'riscv' ? [regs[10], regs[11], regs[12]] : [regs[0], regs[1], regs[2]];
        console.log(
          `[pc] core${i} reached 0x${pc.toString(16)} at instr #${currentInstrNum}: ` +
            `a0=0x${a0.toString(16)} a1=0x${a1.toString(16)} a2=0x${a2.toString(16)}`,
        );
      }
      return orig();
    };
  }
}

/** Disassemble every traced instruction in one batch via objdump. */
function disassemble(entries: TraceEntry[]): string[] {
  if (entries.length === 0) return [];
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const buf = Buffer.alloc(e.wide ? 4 : 2);
    if (coreArch === 'riscv') {
      if (e.wide) buf.writeUInt32LE(((e.hw1 << 16) | e.hw0) >>> 0, 0);
      else buf.writeUInt16LE(e.hw0, 0);
    } else {
      buf.writeUInt16LE(e.hw0, 0);
      if (e.wide) buf.writeUInt16LE(e.hw1, 2);
    }
    chunks.push(buf);
  }
  const blob = Buffer.concat(chunks);
  const tmpFile = path.join(os.tmpdir(), `debug-tracing-${process.pid}.bin`);
  fs.writeFileSync(tmpFile, blob);
  let output: string;
  try {
    output =
      coreArch === 'riscv'
        ? execFileSync(RISCV_OBJDUMP, ['-D', '-b', 'binary', '-m', 'riscv:rv32', tmpFile], {
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 256,
          })
        : execFileSync(
            ARM_OBJDUMP,
            ['-D', '-b', 'binary', '-m', 'arm', '--disassembler-options=force-thumb', tmpFile],
            { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 },
          );
  } catch (e) {
    console.error(`objdump failed (${(e as Error).message}); trace will show raw opcodes only.`);
    return entries.map((e) =>
      e.wide
        ? coreArch === 'riscv'
          ? `.word 0x${(((e.hw1 << 16) | e.hw0) >>> 0).toString(16)}`
          : `.word 0x${e.hw0.toString(16)} 0x${e.hw1.toString(16)}`
        : `<unknown 0x${e.hw0.toString(16)}>`,
    );
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  const asmLines = output
    .split('\n')
    .filter((l) => /^\s*[0-9a-f]+:\t/.test(l))
    .map((l) => {
      const m = l.match(/^\s*[0-9a-f]+:\t[0-9a-f ]+\t(.*)$/);
      return (m ? m[1] : l).trim();
    });
  if (asmLines.length !== entries.length) {
    console.error(
      `objdump produced ${asmLines.length} lines for ${entries.length} traced instructions — ` +
        `disassembly may be misaligned below.`,
    );
  }
  return asmLines;
}

const RISCV_ABI_NAMES = [
  'zero',
  'ra',
  'sp',
  'gp',
  'tp',
  't0',
  't1',
  't2',
  's0',
  's1',
  'a0',
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  's8',
  's9',
  's10',
  's11',
  't3',
  't4',
  't5',
  't6',
];

function formatRegs(e: TraceEntry): string {
  if (coreArch === 'riscv') {
    return e.regs
      .slice(1)
      .map((v, idx) => `${RISCV_ABI_NAMES[idx + 1]}=${v.toString(16)}`)
      .join(' ');
  } else {
    const rNames = e.regs
      .slice(0, 13)
      .map((v, idx) => `r${idx}=${v.toString(16)}`)
      .join(' ');
    const sp = e.regs[13];
    const lr = e.regs[14];
    return `${rNames} sp=0x${sp.toString(16)} lr=0x${lr.toString(16)} ${e.flags}`;
  }
}

function dumpTrace() {
  console.log(
    `\n=== Execution trace: core ${traceCoreNumber}, instructions ` +
      `${traceStartInstructionNumber}-${traceStartInstructionNumber + traceEntries.length - 1}, ` +
      `${traceEntries.length} entries (oldest first, most recent last) ===`,
  );
  const asm = disassemble(traceEntries);
  for (let i = 0; i < traceEntries.length; i++) {
    const e = traceEntries[i];
    const line = asm[i] ?? '?';
    console.log(
      `[core${e.core}] #${e.instrNum} PC=0x${e.pc.toString(16).padStart(8, '0')}  ${line.padEnd(
        32,
      )}  ${formatRegs(e)}`,
    );
  }
}

function dumpStatus(reason: string) {
  console.log(`\n${reason}`);
  console.log(`watchdog fires: ${watchdogFireCount}`);
  if (coreArch === 'riscv') {
    for (const [i, c] of [core0 as RiscvCore, core1 as RiscvCore].entries()) {
      const mstatus = c.csrs[0x300] >>> 0;
      const mie = c.csrs[0x304] >>> 0;
      const meinext = c.csrs[0xbe4] >>> 0;
      const pendingIrqs = c.meipa.reduce(
        (acc, v, irq) => (v ? [...acc, irq] : acc),
        [] as number[],
      );
      const enabledIrqs = c.meiea.reduce(
        (acc, v, irq) => (v ? [...acc, irq] : acc),
        [] as number[],
      );
      console.log(
        `core${i}: pc=0x${(c.PC >>> 0).toString(16)} waiting=${c.waiting} eventRegistered=${
          c.eventRegistered
        } ` +
          `mstatus.MIE=${(mstatus >>> 3) & 1} mie.MEIE=${(mie >>> 11) & 1} ` +
          `meinext=0x${meinext.toString(16)} pendingIrqs=[${pendingIrqs.join(
            ',',
          )}] enabledIrqs=[${enabledIrqs.join(',')}]`,
      );
    }
  } else {
    for (const [i, c] of [core0 as CortexM33Core, core1 as CortexM33Core].entries()) {
      console.log(
        `core${i}: pc=0x${(c.PC >>> 0).toString(16)} waiting=${c.waiting} eventRegistered=${
          c.eventRegistered
        } ` +
          `ipsr=${c.regs.ipsr} primask=${c.regs.primask} faultmask=${c.regs.faultmask} ` +
          `control=0x${c.regs.control.toString(16)}`
      );
    }
  }
  dumpTrace();
}

// ---- Run in bounded batches, yielding to the event loop between them ----

let totalSteps = 0;
function runBatch() {
  try {
    for (let i = 0; i < 1_000_000 && !tracingDone && totalSteps < maxSteps; i++, totalSteps++) {
      mcu.step();
    }
  } catch (e) {
    dumpStatus(
      `CRASH: ${(e as Error).message}\n` +
        `(core ${traceCoreNumber} was at instruction #${currentInstrNum}, PC=0x${(
          tracedCore.PC >>> 0
        ).toString(16)})`,
    );
    process.exit(1);
  }
  if (tracingDone) {
    dumpStatus(`Stopped tracing: ${stopReason}`);
    process.exit(0);
  }
  if (totalSteps >= maxSteps) {
    dumpStatus(
      `Stopped: exhausted maxSteps=${maxSteps} without reaching stopAtInstructionNumber or a crash`,
    );
    process.exit(0);
  }
  setImmediate(runBatch);
}
runBatch();
