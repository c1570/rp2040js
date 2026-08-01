#!/usr/bin/env tsx
// cts2c/cts2c-ensure-parity.ts
//
// Ensures the cts2c C transpile of rp2350js produces identical execution to the
// Node/TS original for a given firmware image. Phases:
//   a) Run Node rp2350js for N cycles, compute per-block CRC32s of PC trace
//   b) Run the C harness for the same, compute matching CRC32s
//   c) Compare — if all match, PASS
//   d) If mismatch: bisect with 100-step blocks to find the divergence window
//   e) Dump PC + all registers per step for both Node and C in that window
//
// Usage: npx tsx cts2c/cts2c-ensure-parity.ts [firmware.hex] [targetCycles] [coreArch]
//   Default: demo/cnm64_main.hex, 50000000 cycles, riscv
//   coreArch: "riscv" (default) or "arm"

import { RP2350 } from '../src';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const HARNESS_BIN = join(ROOT, 'build/transpile/rp2350-harness');
const HARNESS_SRC = join(ROOT, 'cts2c/helper-cts2c-ensure-parity.c');

type CoreArch = 'riscv' | 'arm';

// ─── CRC32 (same algorithm as perf-bench.ts / main.c) ─────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32UpdateU32LE(crc: number, value: number): number {
  crc = crc >>> 0;
  for (let i = 0; i < 4; i++) {
    const b = (value >>> (i * 8)) & 0xff;
    crc = (CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc;
}

// ─── Types ────────────────────────────────────────────────────────────
interface BlockCrc {
  index: number;
  crc: string;
  steps: number;
  cycles: number;
}

interface RegDump {
  step: number;
  pc: number;
  regs: number[];
}

// Host-facing output is irrelevant to a PC-trace comparison, and UART bytes /
// GPIO listener logs would flood the console over hundreds of millions of cycles.
const noop = () => undefined;

function silenceHostIO(mcu: RP2350) {
  mcu.uart[0].onByte = noop;
  for (let i = 0; i < 11; i++) mcu.gpio[i].addListener(noop);
}

// ─── Node emulator runner ─────────────────────────────────────────────
function runNode(
  hexFile: string,
  cycles: number,
  blockSize: number,
  quietUntil: number,
  coreArch: CoreArch
): BlockCrc[] {
  const mcu = new RP2350({ loadFirmware: hexFile, coreArch });
  silenceHostIO(mcu);

  const results: BlockCrc[] = [];
  let steps = 0;
  let blockCrc = 0xffffffff;
  let blockSteps = 0;
  let blockIndex = 0;

  while (mcu.cycles < cycles) {
    mcu.step();
    steps++;
    blockCrc = crc32UpdateU32LE(blockCrc, mcu.core[0].PC >>> 0);
    blockSteps++;
    if (blockSteps === blockSize) {
      if (steps > quietUntil)
        results.push({
          index: blockIndex,
          crc: ((blockCrc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'),
          steps: blockSteps,
          cycles: mcu.cycles,
        });
      blockIndex++;
      blockSteps = 0;
      blockCrc = 0xffffffff;
    }
  }
  if (blockSteps > 0 && steps > quietUntil)
    results.push({
      index: blockIndex,
      crc: ((blockCrc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0'),
      steps: blockSteps,
      cycles: mcu.cycles,
    });
  return results;
}

// ─── Node register dump ──────────────────────────────────────────────
// RISC-V has 32 general registers (x0-x31); ARM (Cortex-M33) has only 16
// (r0-r12, sp, lr, pc) — padded to the same 32-wide dump shape with zeros so
// the rest of this file's comparison/print logic doesn't need to know which
// arch it's looking at.
function dumpNodeRegs(
  hexFile: string,
  startStep: number,
  count: number,
  coreArch: CoreArch
): RegDump[] {
  const mcu = new RP2350({ loadFirmware: hexFile, coreArch });
  silenceHostIO(mcu);

  const core = mcu.core[0] as any;
  const endStep = startStep + count;
  const dumps: RegDump[] = [];
  let steps = 0;

  while (mcu.cycles < 60_000_000) {
    mcu.step();
    steps++;
    if (steps >= startStep && steps < endStep) {
      const regs: number[] = new Array(32).fill(0);
      if (coreArch === 'arm') {
        for (let i = 0; i < 16; i++) regs[i] = core.regs.r[i] >>> 0;
      } else {
        for (let i = 0; i < 32; i++) regs[i] = core.registerSet.getRegisterU(i) >>> 0;
      }
      dumps.push({ step: steps, pc: core.PC >>> 0, regs });
    }
    if (steps >= endStep) break;
  }
  return dumps;
}

// ─── C harness runner ─────────────────────────────────────────────────
function runC(
  hexFile: string,
  cycles: number,
  blockSize: number,
  quietUntil: number,
  coreArch: CoreArch
): BlockCrc[] {
  const result = spawnSync(
    HARNESS_BIN,
    [hexFile, String(cycles), String(blockSize), String(quietUntil), '0', '100', coreArch],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
  );
  // A crash (e.g. SIGSEGV) makes the harness produce fewer/zero pc_trace lines than a
  // real run would — without this check, that silently looks like "no mismatch found"
  // to findFirstMismatch (which only ever compares indices both sides actually have),
  // i.e. a genuine crash gets reported as PASS. Found exactly this way: the first arm
  // run of this script crashed the C harness immediately (a real, separate bug) and
  // still printed "PASS: all 1 CRC32 blocks match".
  if (result.signal) {
    throw new Error(
      `C harness (${HARNESS_BIN}) was killed by signal ${
        result.signal
      } — likely a crash, not a clean run. stderr tail:\n${(result.stderr || '')
        .split('\n')
        .slice(-20)
        .join('\n')}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `C harness (${HARNESS_BIN}) exited with status ${result.status}. stderr tail:\n${(
        result.stderr || ''
      )
        .split('\n')
        .slice(-20)
        .join('\n')}`
    );
  }
  const lines = (result.stderr || '').split('\n');
  const blocks: BlockCrc[] = [];
  for (const line of lines) {
    const m = line.match(/pc_trace block=(\d+) steps=(\d+) cycles=(\d+) crc32=(0x[0-9a-f]+)/);
    if (m) {
      blocks.push({
        index: +m[1],
        crc: m[4].slice(2),
        steps: +m[2],
        cycles: +m[3],
      });
    }
  }
  return blocks;
}

// ─── C register dump ─────────────────────────────────────────────────
function dumpCRegs(
  hexFile: string,
  startStep: number,
  count: number,
  coreArch: CoreArch
): RegDump[] {
  const result = spawnSync(
    HARNESS_BIN,
    [hexFile, '60000000', '1', '0', String(startStep), String(count), coreArch],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
  );
  // Same reasoning as runC's identical check: a crash before reaching dumpStart
  // produces zero DUMP lines, which would otherwise look like "no register
  // difference found" instead of a crash.
  if (result.signal) {
    throw new Error(
      `C harness (${HARNESS_BIN}) was killed by signal ${
        result.signal
      } during register dump. stderr tail:\n${(result.stderr || '')
        .split('\n')
        .slice(-20)
        .join('\n')}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `C harness (${HARNESS_BIN}) exited with status ${
        result.status
      } during register dump. stderr tail:\n${(result.stderr || '')
        .split('\n')
        .slice(-20)
        .join('\n')}`
    );
  }
  const lines = (result.stderr || '').split('\n');
  const dumps: RegDump[] = [];
  for (const line of lines) {
    if (!line.startsWith('DUMP ')) continue;
    const parts = line.trim().split(' ');
    let step = 0;
    let pc = 0;
    const regs: number[] = new Array(32).fill(0);
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      const key = p.slice(0, eq);
      const raw = p.slice(eq + 1);
      const val = parseInt(raw, 16);
      if (key === 'step') step = parseInt(raw, 10);
      else if (key === 'pc') pc = val;
      else if (key.startsWith('x')) {
        const idx = parseInt(key.slice(1));
        if (idx >= 0 && idx < 32) regs[idx] = val;
      }
    }
    dumps.push({ step, pc, regs });
  }
  return dumps;
}

// ─── C crash bisection ────────────────────────────────────────────────
// A C-side crash (SIGSEGV/SIGABRT etc., not just a diverging CRC) is a different
// failure mode than phases 1-3 above are built for: those assume the C harness
// runs to completion and just produces different numbers. When it dies outright,
// there's no point re-running the same doomed target-cycle count over and over —
// what's actually useful is finding the EXACT step it dies at, so it can be
// compared against Node at that same point. Reuses the harness's existing
// dump-mode CLI (`dumpStart=N, dumpCount=1`) as a cheap "did execution survive to
// at least step N" probe: a clean exit means yes, a signal/non-zero status means
// it died at or before N. Execution is fully deterministic (no wall-clock or
// randomness in the emulator), so "the harness crashes by step N" is monotonic —
// once corrupted, always corrupted — which is exactly what binary search needs.
// Found necessary via a real run: the ARM m33_blink firmware's C build crashes
// with "Read from invalid memory address" well inside the first 1M-step block,
// while Node runs the same firmware for 5M+ steps with no error at all — a
// genuine divergence, previously reported as a raw uncaught exception with no
// indication of where it actually happened.
function probeCSurvives(hexFile: string, step: number, coreArch: CoreArch): boolean {
  const result = spawnSync(
    HARNESS_BIN,
    [hexFile, '2000000000', '1', '0', String(step), '1', coreArch],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
  );
  return !result.signal && result.status === 0;
}

function findCCrashStep(hexFile: string, coreArch: CoreArch): number {
  let lo = 1;
  let hi = 2_000_000;
  // Expand the upper bound until we actually observe a crash within it — the
  // caller only gets here because SOME run crashed, but that run's target-cycle
  // count may be far beyond where the crash first manifests.
  while (probeCSurvives(hexFile, hi, coreArch)) {
    lo = hi;
    hi *= 2;
    if (hi > 500_000_000)
      throw new Error(
        'findCCrashStep: harness survives up to 500M steps — cannot locate the crash reported earlier'
      );
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (probeCSurvives(hexFile, mid, coreArch)) lo = mid;
    else hi = mid;
  }
  return hi; // first step at which the harness no longer survives
}

// Single-step register-dump equality — PC plus every general register.
function regDumpsEqual(a: RegDump, b: RegDump): boolean {
  if (a.pc !== b.pc) return false;
  for (let i = 0; i < 32; i++) if (a.regs[i] !== b.regs[i]) return false;
  return true;
}

// Binary search for the SMALLEST step at which Node and C first disagree on
// PC/registers, using single-step dump probes on both sides (as opposed to
// findCCrashStep, which only finds where C dies outright — a crash is usually
// a downstream SYMPTOM of an earlier wrong branch/register value, not the root
// cause). Found necessary via a real run: the ARM m33_blink firmware's C build
// crashes at step ~1.29M, but a register dump right before the crash already
// shows Node and C executing completely different code paths (Node parked at
// a steady PC, C bouncing between two unrelated small addresses) — the crash
// step alone is a red herring for root-causing, the actual divergence is much
// earlier. Same monotonic-execution assumption as findCCrashStep: once PC/regs
// genuinely diverge, they don't coincidentally re-converge to bit-identical
// values, so binary search converges on the true first divergence.
function findFirstDivergentStep(
  hexFile: string,
  coreArch: CoreArch,
  upperBound: number
): number | null {
  const matches = (step: number): boolean => {
    const n = dumpNodeRegs(hexFile, step, 1, coreArch)[0];
    const c = dumpCRegs(hexFile, step, 1, coreArch)[0];
    if (!n || !c) return true; // out of range on either side — not a divergence to report here
    return regDumpsEqual(n, c);
  };
  if (upperBound < 1 || matches(upperBound)) return null;
  let lo = 0; // step 0 (pre-first-step reset state) is assumed identical on both sides
  let hi = upperBound;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (matches(mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ─── Comparison helpers ──────────────────────────────────────────────
function findFirstMismatch(a: BlockCrc[], b: BlockCrc[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i].crc !== b[i].crc) return i;
  }
  return -1;
}

function fmtReg(v: number): string {
  return '0x' + (v >>> 0).toString(16).padStart(8, '0');
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const hexFile = process.argv[2] || 'demo/cnm64_main.hex';
  const targetCycles = Number(process.argv[3]) || 50_000_000;
  const coreArchArg = process.argv[4] || 'riscv';
  if (coreArchArg !== 'riscv' && coreArchArg !== 'arm') {
    console.error(`Invalid coreArch "${coreArchArg}" — expected "riscv" or "arm"`);
    process.exit(1);
  }
  const coreArch: CoreArch = coreArchArg;
  const COARSE_BLOCK = 1_000_000;
  const FINE_BLOCK = 100;

  console.log(`cts2c-ensure-parity: ${hexFile}, ${targetCycles} cycles, coreArch=${coreArch}`);
  console.log('');

  // ── Build C harness ──────────────────────────────────────────────
  // The transpile+gcc step dominates a short run (~7s of an ~8s 5M-cycle run, where
  // the comparison itself is under a second), so a caller invoking this script more
  // than once against unchanged sources can build once and skip the rest — see
  // cts2c-parity.spec.ts, which compares both architectures.
  if (process.env.CTS2C_SKIP_BUILD === '1') {
    console.log('[build] skipped (CTS2C_SKIP_BUILD=1)');
  } else {
    console.log('[build] cts2c + gcc...');
    execSync('npm run cts2c:full', { cwd: ROOT, stdio: 'pipe' });
    execSync(`gcc -O3 -Wall ${HARNESS_SRC} -o ${HARNESS_BIN} -lm`, {
      cwd: ROOT,
      stdio: 'pipe',
    });
    console.log('[build] done');
  }
  console.log('');

  // ── Phase 1: Coarse comparison (1M-step blocks) ──────────────────
  console.log('[phase 1] Node: 1M-step blocks...');
  const t0 = Date.now();
  const nodeBlocks = runNode(hexFile, targetCycles, COARSE_BLOCK, 0, coreArch);
  console.log(`[phase 1] Node done: ${nodeBlocks.length} blocks, ${Date.now() - t0}ms`);

  console.log('[phase 1] C: 1M-step blocks...');
  const t1 = Date.now();
  let cBlocks: BlockCrc[];
  try {
    cBlocks = runC(hexFile, targetCycles, COARSE_BLOCK, 0, coreArch);
  } catch (e) {
    // The C harness died outright (not just a diverging CRC) — bisect for the
    // exact step, then dump + compare both sides right around it. See
    // findCCrashStep's own comment for why this works and why it's worth doing
    // instead of just re-throwing the raw crash.
    console.log('');
    console.log(`[phase 1] C harness crashed: ${(e as Error).message.split('\n')[0]}`);
    console.log('[phase 1] Bisecting for the exact crash step...');
    const crashStep = findCCrashStep(hexFile, coreArch);
    console.log(
      `[phase 1] C harness dies at step ${crashStep} (last confirmed-surviving step: ${
        crashStep - 1
      })`
    );
    console.log(
      '[phase 1] Bisecting for the true first PC/register divergence (may be well before the crash)...'
    );
    const divergeStep = findFirstDivergentStep(hexFile, coreArch, crashStep - 1);
    if (divergeStep !== null) {
      console.log(
        `[phase 1] First divergence at step ${divergeStep} — ${
          crashStep - divergeStep
        } steps before the crash`
      );
    } else {
      console.log(
        '[phase 1] No earlier divergence found — the crash step itself is the first anomaly'
      );
    }
    console.log('');

    // Center the dump window on whichever is more useful: the true divergence
    // point if bisection found one earlier, otherwise the crash itself.
    const centerStep = divergeStep ?? crashStep;
    const dumpStart = Math.max(1, centerStep - Math.floor(FINE_BLOCK / 2));
    const dumpEnd = Math.min(crashStep, dumpStart + FINE_BLOCK);
    console.log(
      `[phase 1] Dumping steps ${dumpStart}..${dumpEnd} (C only survives to ${crashStep - 1})...`
    );
    const nodeDumps = dumpNodeRegs(hexFile, dumpStart, dumpEnd - dumpStart, coreArch);
    const cDumps = dumpCRegs(hexFile, dumpStart, dumpEnd - dumpStart, coreArch);

    console.log('');
    console.log(`  ── NODE (steps ${dumpStart}..${dumpEnd}) ──`);
    const header = `  step     PC          x0..x31`;
    console.log(header);
    for (const d of nodeDumps) {
      const mark = d.step === divergeStep ? '>>' : '  ';
      console.log(
        `${mark} ${String(d.step).padStart(8)} ${fmtReg(d.pc)}  ${d.regs
          .slice(0, 8)
          .map(fmtReg)
          .join(' ')}`
      );
    }
    console.log('');
    console.log(`  ── C (last surviving steps) ──`);
    console.log(header);
    for (const d of cDumps) {
      const mark = d.step === divergeStep ? '>>' : '  ';
      console.log(
        `${mark} ${String(d.step).padStart(8)} ${fmtReg(d.pc)}  ${d.regs
          .slice(0, 8)
          .map(fmtReg)
          .join(' ')}`
      );
    }

    console.log('');
    if (divergeStep !== null) {
      console.log(
        `FAIL: first PC/register divergence at step ${divergeStep} (C harness crashes later, at step ${crashStep}).`
      );
    } else {
      console.log(
        `FAIL: C harness crashes at step ${crashStep} — Node runs past it with no error.`
      );
    }
    process.exit(1);
  }
  console.log(`[phase 1] C done: ${cBlocks.length} blocks, ${Date.now() - t1}ms`);

  const mismatch = findFirstMismatch(nodeBlocks, cBlocks);
  if (mismatch === -1) {
    console.log('');
    console.log(`PASS: all ${nodeBlocks.length} CRC32 blocks match`);
    return;
  }

  console.log('');
  console.log(`[phase 1] MISMATCH at block ${mismatch}:`);
  console.log(`  Node: ${nodeBlocks[mismatch].crc}`);
  console.log(`  C:    ${cBlocks[mismatch].crc}`);

  // ── Phase 2: Bisect with 100-step blocks ─────────────────────────
  const regionStart = mismatch * COARSE_BLOCK;
  console.log('');
  console.log(
    `[phase 2] Bisecting region starting at step ${regionStart} with ${FINE_BLOCK}-step blocks...`
  );

  console.log('[phase 2] Node: 100-step blocks...');
  const nodeFine = runNode(hexFile, targetCycles, FINE_BLOCK, regionStart, coreArch);

  console.log('[phase 2] C: 100-step blocks...');
  const cFine = runC(hexFile, targetCycles, FINE_BLOCK, regionStart, coreArch);

  const fineMismatch = findFirstMismatch(nodeFine, cFine);
  if (fineMismatch === -1) {
    console.log('[phase 2] No fine mismatch found (unexpected). Aborting.');
    process.exit(1);
  }

  const divergenceStep = regionStart + fineMismatch * FINE_BLOCK;
  console.log(`[phase 2] Divergence at step ${divergenceStep}`);
  console.log(`  Node: ${nodeFine[fineMismatch].crc}`);
  console.log(`  C:    ${cFine[fineMismatch].crc}`);

  // ── Phase 3: Dump PC + registers for the 100-step window ─────────
  console.log('');
  console.log(`[phase 3] Dumping ${FINE_BLOCK}-step window from step ${divergenceStep}...`);
  console.log('');

  const nodeDumps = dumpNodeRegs(hexFile, divergenceStep, FINE_BLOCK, coreArch);
  const cDumps = dumpCRegs(hexFile, divergenceStep, FINE_BLOCK, coreArch);

  // Print side-by-side, stop at first diff
  const len = Math.max(nodeDumps.length, cDumps.length);
  let firstDiff = -1;
  for (let i = 0; i < len; i++) {
    const nd = nodeDumps[i];
    const cd = cDumps[i];
    if (!nd || !cd) {
      firstDiff = i;
      break;
    }
    const pcMatch = nd.pc === cd.pc;
    const regDiff: string[] = [];
    for (let r = 0; r < 32; r++) {
      if (nd.regs[r] !== cd.regs[r]) regDiff.push(`x${r}`);
    }
    if (!pcMatch || regDiff.length > 0) {
      firstDiff = i;
      break;
    }
  }

  if (firstDiff === -1) {
    console.log(
      'No register difference found in window (CRC mismatch may be in a field not dumped).'
    );
    return;
  }

  // Print the last few matching steps + first divergent step
  const showStart = Math.max(0, firstDiff - 3);
  const showEnd = Math.min(len, firstDiff + 4);

  const header = `  step     PC          x0..x31 (differences marked with *)`;
  const sep = '  ' + '-'.repeat(120);
  console.log('  ── NODE ──');
  console.log(header);
  console.log(sep);
  for (let i = showStart; i < showEnd; i++) {
    if (!nodeDumps[i]) break;
    const d = nodeDumps[i];
    const mark = i === firstDiff ? '>>' : '  ';
    const regStrs = d.regs.map((v, r) => {
      const cd = cDumps[i];
      const diff = cd && v !== cd.regs[r] ? '*' : ' ';
      return `${diff}${fmtReg(v)}`;
    });
    console.log(
      `${mark} ${String(d.step).padStart(8)} ${fmtReg(d.pc)}  ${regStrs.slice(0, 8).join(' ')}`
    );
    console.log(`${mark} ${' '.repeat(8)} ${' '.repeat(10)}  ${regStrs.slice(8, 16).join(' ')}`);
    console.log(`${mark} ${' '.repeat(8)} ${' '.repeat(10)}  ${regStrs.slice(16, 24).join(' ')}`);
    console.log(`${mark} ${' '.repeat(8)} ${' '.repeat(10)}  ${regStrs.slice(24, 32).join(' ')}`);
  }

  console.log('');
  console.log('  ── C ──');
  console.log(header);
  console.log(sep);
  for (let i = showStart; i < showEnd; i++) {
    if (!cDumps[i]) break;
    const d = cDumps[i];
    const mark = i === firstDiff ? '>>' : '  ';
    const regStrs = d.regs.map((v, r) => {
      const nd = nodeDumps[i];
      const diff = nd && v !== nd.regs[r] ? '*' : ' ';
      return `${diff}${fmtReg(v)}`;
    });
    console.log(
      `${mark} ${String(d.step).padStart(8)} ${fmtReg(d.pc)}  ${regStrs.slice(0, 8).join(' ')}`
    );
    console.log(`${mark} ${' '.repeat(8)} ${' '.repeat(10)}  ${regStrs.slice(8, 16).join(' ')}`);
    console.log(`${mark} ${' '.repeat(8)} ${' '.repeat(10)}  ${regStrs.slice(16, 24).join(' ')}`);
    console.log(`${mark} ${' '.repeat(8)} ${' '.repeat(10)}  ${regStrs.slice(24, 32).join(' ')}`);
  }

  // Summary
  if (firstDiff >= 0 && nodeDumps[firstDiff] && cDumps[firstDiff]) {
    const nd = nodeDumps[firstDiff];
    const cd = cDumps[firstDiff];
    console.log('');
    console.log(`FAIL: first divergence at step ${nd.step}`);
    if (nd.pc !== cd.pc) console.log(`  PC:  Node=${fmtReg(nd.pc)}  C=${fmtReg(cd.pc)}`);
    for (let r = 0; r < 32; r++) {
      if (nd.regs[r] !== cd.regs[r])
        console.log(
          `  x${String(r).padStart(2)}: Node=${fmtReg(nd.regs[r])}  C=${fmtReg(cd.regs[r])}`
        );
    }
  }

  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
