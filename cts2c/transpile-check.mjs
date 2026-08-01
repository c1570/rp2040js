#!/usr/bin/env node
// Transpile (subsets of) src/ to C via cts2c.js, compile with gcc, summarize results.
//
// Usage:
//   node cts2c/transpile-check.mjs [full] [--gcc-args "-O3 -Wall"]
//   node cts2c/transpile-check.mjs --files src/a.ts src/b.ts
//
// Mode:
//   full  — every .ts file under src/, excluding *.spec.ts, *.d.ts, gdb/, mcp/, rp2-emu-cli/,
//           emulator-controller.ts and pio-gpio-dump.ts (MCP/rp2_emu-CLI/GDB-monitor-only
//           debug/string-formatting surface — not part of the emulator core), rp2040.ts
//           itself (out of scope — this project targets an RP2350 C transpile only, and
//           rp2040.ts pulls in a parallel set of RP2040-only peripherals/casts not worth
//           chasing), simulator.ts (an RP2040-based demo/debug harness — unused anywhere in
//           src/, out of scope like rp2040.ts), and ppb.ts/syscfg.ts (RP2040-only
//           peripherals — RP2350 has its own ppb_rp2350.ts/syscfg_rp2350.ts. Both do
//           `this.rp2040 as unknown as RP2040` then index a field on the cast result; cts2c
//           doesn't resolve field access through that cast pattern yet, degrading to
//           int32_t. Not worth chasing until cts2c builds a real IRPChip vtable-value at
//           cast sites)
//
// Output goes to build/transpile/full.{c,o,manifest.txt,gcc.log} so runs are reproducible
// and diffable across commits.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const OUT_DIR = join(ROOT, 'build', 'transpile');

function findTsFiles(dir, exclude) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (exclude.some((ex) => rel.includes(ex))) continue;
    if (entry.isDirectory()) {
      out.push(...findTsFiles(full, exclude));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function parseArgs(argv) {
  let files = null;
  let gccArgs = ['-O3', '-Wall'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'full') continue;
    else if (a === '--files') {
      files = [];
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) files.push(argv[++i]);
    } else if (a === '--gcc-args') gccArgs = argv[++i].split(' ');
  }
  return { files, gccArgs };
}

const { files: explicitFiles, gccArgs } = parseArgs(process.argv.slice(2));

const FULL_EXCLUDE = [
  'src/gdb/',
  'src/mcp/',
  'src/rp2-emu-cli/',
  'src/utils/emulator-controller.ts',
  'src/utils/pio-gpio-dump.ts',
  'src/rp2040.ts',
  'src/simulator.ts',
  'src/peripherals/ppb.ts',
  'src/peripherals/syscfg.ts',
  // RP2040-only ARM Cortex-M0+ core (RP2350 uses CortexM33Core, or the RISC-V CPU
  // core — never this one). Explicitly typed to concrete RP2040 (not ChipType-
  // generic), only ever constructed in rp2040.ts (already excluded above) — so its
  // methods, which call RP2040_readUint32/writeUint32/etc., link-fail in a harness
  // that never emits rp2040.ts's own bodies. Dead code for an RP2350-only build.
  'src/cortex-m0-core.ts',
];

let inputFiles;
let label;
if (explicitFiles) {
  inputFiles = explicitFiles.map((f) => (f.startsWith('/') ? f : join(ROOT, f)));
  label = 'custom';
} else {
  inputFiles = findTsFiles(SRC, FULL_EXCLUDE).sort();
  label = 'full';
}

mkdirSync(OUT_DIR, { recursive: true });
const cFile = join(OUT_DIR, `${label}.c`);
const oFile = join(OUT_DIR, `${label}.o`);
const manifestFile = join(OUT_DIR, `${label}.manifest.txt`);
const gccLogFile = join(OUT_DIR, `${label}.gcc.log`);
const todoLogFile = join(OUT_DIR, `${label}.todo.log`);

writeFileSync(manifestFile, inputFiles.map((f) => relative(ROOT, f)).join('\n') + '\n');

console.log(`── cts2c: transpiling ${inputFiles.length} file(s) [${label}] ──`);
let cts2cOk = true;
try {
  execFileSync('node', [join(ROOT, 'cts2c', 'cts2c.js'), ...inputFiles, '-o', cFile], {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (e) {
  cts2cOk = false;
  console.error(`cts2c.js failed: ${e.message}`);
}

if (!cts2cOk) process.exit(1);

// cts2c.js embeds "/* TODO: ... */" markers in the generated C wherever it had to stub
// something out (untyped fields, unsupported dispatch, unhandled node types, etc). Some
// of these compile clean but are silently wrong (e.g. `(0) /* TODO: .length */`), so gcc's
// error count alone understates how much is unhandled — surface them separately.
const cSource = readFileSync(cFile, 'utf8');
const cLines = cSource.split('\n');
// cts2c.js appends " [src/foo.ts:123: <original line>]" to each TODO comment when it
// can resolve source location — pull that out separately from the TODO's own text.
const SOURCE_LOC_RE = /\s*\[([^\[\]]+?):(\d+): (.*)\]$/;
const todoHits = [];
cLines.forEach((line, i) => {
  const m = line.match(/\/\* TODO:.*?\*\//g);
  if (m) {
    for (const hit of m) {
      const inner = hit.replace(/^\/\*\s*/, '').replace(/\s*\*\/$/, '');
      const locMatch = inner.match(SOURCE_LOC_RE);
      const bodyText = locMatch ? inner.slice(0, locMatch.index).trim() : inner.trim();
      const source = locMatch
        ? { file: locMatch[1], line: Number(locMatch[2]), text: locMatch[3] }
        : null;
      todoHits.push({ cLine: i + 1, text: hit, bodyText, source });
    }
  }
});
writeFileSync(
  todoLogFile,
  todoHits
    .map((h) =>
      h.source
        ? `${relative(ROOT, cFile)}:${h.cLine}: ${h.bodyText}  <-  ${h.source.file}:${
            h.source.line
          }: ${h.source.text}`
        : `${relative(ROOT, cFile)}:${h.cLine}: ${h.text}`
    )
    .join('\n') + (todoHits.length ? '\n' : '')
);

// Known cts2c.js TODO shapes, most-specific first, mapped to a human label.
// (Keep in sync with the `/* TODO: ... */` emit sites in cts2c.js if new ones are added.)
const TODO_PATTERNS = [
  [/^\.[\w$]+\s*=$/, 'uninitialized struct field (ctor param had no resolvable type)'],
  [/^2D array /, 'unsupported 2D array declaration'],
  [/^stubbed: uses unsupported JS$/, 'method body stubbed (unsupported JS construct)'],
  [/^stubbed$/, 'function/method body stubbed (no implementation emitted)'],
  [/^dynamic case /, 'switch case with non-constant expression'],
  [/^\.length$/, '.length on untyped/unresolved value'],
  [/^this\.length$/, 'this.length on untyped self'],
  [/^iface\.[\w$]+\[idx\]$/, 'interface field array-index access (unresolved)'],
  [/^iface\.[\w$]+\.[\w$]+\[idx\]$/, 'interface nested field array-index access (unresolved)'],
  [/^iface\.[\w$]+$/, 'interface field/method access (unresolved dispatch)'],
  [/^chained /, 'stub propagated through chained property access'],
  [/^iface assign$/, 'assignment through unresolved interface field'],
  [/^super\(\)$/, 'super() constructor call'],
  [/^Math\.\w+$/, 'unsupported Math.* method'],
  [/^console\.\w+$/, 'console.* call'],
  [/^log$/, 'logging call'],
  [/^String\.fromCharCode$/, 'String.fromCharCode'],
  [/^\.set\(\)$/, 'TypedArray .set()'],
  [/^(subarray|slice)$/, 'TypedArray .subarray()/.slice()'],
  [/^indexOf$/, 'Array/String .indexOf()'],
  [/^push$/, 'Array .push()'],
  [/^dispatch \w+$/, 'unresolved method dispatch by name'],
  [/^new \w+\(\)$/, 'unsupported constructor call (new X())'],
  [/^array literal$/, 'array literal expression'],
  [/^template$/, 'template literal expression'],
  [/^not implemented$/, 'vtable slot with no implementation'],
];

function classifyTodo(bodyText) {
  const inner = bodyText.replace(/^TODO:\s*/, '').trim();
  for (const [re, label] of TODO_PATTERNS) {
    if (re.test(inner)) return label;
  }
  return `other: ${inner}`;
}

function summarizeTodos(hits) {
  const counts = new Map();
  for (const { bodyText } of hits) {
    const key = classifyTodo(bodyText);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
const todoGroups = summarizeTodos(todoHits);

console.log(`── gcc ${gccArgs.join(' ')} -c ${relative(ROOT, cFile)} ──`);
const gcc = spawnSync('gcc', [...gccArgs, '-c', cFile, '-o', oFile], { encoding: 'utf8' });
const gccOutput = (gcc.stdout || '') + (gcc.stderr || '');
writeFileSync(gccLogFile, gccOutput);

const errorLines = gccOutput.split('\n').filter((l) => / error: /.test(l));
const warningLines = gccOutput.split('\n').filter((l) => / warning: /.test(l));

function summarizeByMessage(lines, re) {
  const counts = new Map();
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const key = m[1].replace(/['`][^'`]*['`]/g, '<x>').trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const errorGroups = summarizeByMessage(errorLines, / error: (.+)$/);
const warningGroups = summarizeByMessage(warningLines, / warning: (.+?)(?:\s*\[-W|$)/);

console.log('');
console.log(`═══ Summary [${label}] ═══`);
console.log(`Files transpiled : ${inputFiles.length}`);
console.log(
  `C output         : ${relative(ROOT, cFile)} (${
    gcc.status === null ? 'n/a' : 'compiled attempt'
  })`
);
console.log(`Errors           : ${errorLines.length}`);
console.log(`Warnings         : ${warningLines.length}`);
console.log(
  `TODO stubs       : ${todoHits.length} (semantic gaps cts2c couldn't translate — may compile clean)`
);

if (todoGroups.length) {
  console.log('');
  console.log('Top TODO categories (from generated C, not gcc):');
  for (const [msg, count] of todoGroups.slice(0, 15)) {
    console.log(`  ${String(count).padStart(4)}  ${msg}`);
  }
}

if (errorGroups.length) {
  console.log('');
  console.log('Top error categories:');
  for (const [msg, count] of errorGroups.slice(0, 15)) {
    console.log(`  ${String(count).padStart(4)}  ${msg}`);
  }
}

if (warningGroups.length) {
  console.log('');
  console.log('Top warning categories:');
  for (const [msg, count] of warningGroups.slice(0, 10)) {
    console.log(`  ${String(count).padStart(4)}  ${msg}`);
  }
}

console.log('');
console.log(`Manifest : ${relative(ROOT, manifestFile)}`);
console.log(`gcc log  : ${relative(ROOT, gccLogFile)}`);
console.log(`TODO log : ${relative(ROOT, todoLogFile)}`);

process.exit(errorLines.length > 0 ? 1 : 0);
