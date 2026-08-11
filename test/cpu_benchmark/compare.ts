// CPU benchmark comparison harness — runs cpu_benchmark across all three archs
// (RP2040 / RP2350-ARM / RP2350-RISC-V) under both the TS emulator and the C
// (cts2c-transpiled) emulator, then verifies the UART checksums match between
// TS and C for every arch and reports cycles/sec side-by-side.
//
// Usage: npx tsx test/cpu_benchmark/compare.ts [targetCycles]
//
// Prereqs:
//   - Built firmware: test/cpu_benchmark/cpu_benchmark_{rp2040,rp2350_arm,rp2350_riscv}.hex
//     (run the CMake builds — see CMakeLists.txt / commit history)
//   - C transpile: npm run cts2c:full  (this script will invoke it if the header is missing)
import { execSync, spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '../..');
const targetCycles = process.argv[2] || '300000000';

const C_HEADER = join(ROOT, 'build/transpile/rp2350js-c.h');
const C_HARNESS_SRC = join(ROOT, 'test/cpu_benchmark/run-bench.c');
const C_HARNESS_BIN = join(ROOT, 'build/transpile/cpu-bench');
const TS_RUNNER = join(ROOT, 'test/cpu_benchmark/run-bench.ts');

type ArchResults = { lines: string[]; cyclesPerSec: number };
type RunnerOutput = { targetCycles: number; results: Record<string, ArchResults> };

function run(cmd: string, args: string[], opts: { cwd: string; maxBuffer?: number }) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer ?? 100 * 1024 * 1024,
  });
  if (r.signal) throw new Error(`${cmd} killed by ${r.signal}`);
  if (r.status !== 0)
    throw new Error(`${cmd} exited ${r.status}:\n${(r.stderr || '').slice(-1000)}`);
  return r;
}

function ensureCHarness() {
  const needsBuild =
    !existsSync(C_HEADER) ||
    !existsSync(C_HARNESS_BIN) ||
    statSync(C_HARNESS_SRC).mtimeMs > statSync(C_HARNESS_BIN).mtimeMs ||
    statSync(C_HEADER).mtimeMs > statSync(C_HARNESS_BIN).mtimeMs;

  if (!needsBuild) {
    console.log('[build] C harness up to date — skipping');
    return;
  }

  if (!existsSync(C_HEADER)) {
    console.log('[build] C header missing — running cts2c:full...');
    execSync('npm run cts2c:full', { cwd: ROOT, stdio: 'inherit' });
  }
  console.log('[build] compiling C harness...');
  execSync(`gcc -O3 -Wall -Ibuild/transpile ${C_HARNESS_SRC} -o ${C_HARNESS_BIN} -lm`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function parseJSON<T>(stdout: string): T {
  const marker = stdout.indexOf('---JSON---\n');
  const jsonText = marker >= 0 ? stdout.slice(marker + '---JSON---\n'.length) : stdout;
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON found in output');
  const jsonSlice = jsonText.slice(start, end + 1);
  // Strip stray non-printable bytes (UART debug noise that leaked into stdout)
  // that would break JSON.parse as "Bad control character".
  const clean = jsonSlice.replace(/[\x00-\x1f\x7f-\x9f]/g, (ch) => {
    // Keep valid JSON whitespace (\n, \r, \t are already excluded by the range above,
    // but \b \f are valid JSON escapes — unlikely in our output, so just drop them).
    return '';
  });
  return JSON.parse(clean);
}

function compareLines(ts: string[], c: string[], arch: string): { ok: boolean; note?: string } {
  if (ts.length !== c.length) return { ok: false, note: `line count ${ts.length} vs ${c.length}` };
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] !== c[i]) return { ok: false, note: `line ${i}: "${ts[i]}" != "${c[i]}"` };
  }
  return { ok: true };
}

console.log(`\n=== CPU Benchmark Comparison (target ${targetCycles} cycles) ===\n`);

ensureCHarness();

console.log('\n[run] TS emulator...');
const tsResult = run('npx', ['tsx', TS_RUNNER, targetCycles], { cwd: ROOT });
const tsOut = parseJSON<RunnerOutput>(tsResult.stdout);

console.log('[run] C emulator...');
const cResult = run(C_HARNESS_BIN, [targetCycles], { cwd: ROOT });
const cOut = parseJSON<RunnerOutput>(cResult.stdout);

const archs = ['rp2040', 'arm', 'riscv'];
console.log('\n--- Results ---\n');
console.log(
  `${'arch'.padEnd(8)}  ${'TS cycles/s'.padStart(16)}  ${'C cycles/s'.padStart(
    16
  )}  ${'C/TS'.padStart(6)}  checksums`
);
let allOk = true;
for (const arch of archs) {
  const ts = tsOut.results[arch];
  const c = cOut.results[arch];
  if (!ts || !c) {
    console.log(`${arch.padEnd(8)}  MISSING`);
    allOk = false;
    continue;
  }
  const cmp = compareLines(ts.lines, c.lines, arch);
  if (!cmp.ok) allOk = false;
  const speedup = ts.cyclesPerSec > 0 ? (c.cyclesPerSec / ts.cyclesPerSec).toFixed(1) + 'x' : '—';
  const status = cmp.ok ? 'OK' : `FAIL (${cmp.note})`;
  console.log(
    `${arch.padEnd(8)}  ${ts.cyclesPerSec.toLocaleString().padStart(16)}  ${c.cyclesPerSec
      .toLocaleString()
      .padStart(16)}  ${speedup.padStart(6)}  ${status}`
  );
}

// Sample output (first print line per arch)
console.log('\n--- Sample UART output ---\n');
for (const arch of archs) {
  const line = tsOut.results[arch]?.lines[0];
  if (line) console.log(`  [${arch}] ${line}`);
}

process.exit(allOk ? 0 : 1);
