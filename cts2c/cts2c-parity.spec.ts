import { beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

// Node-vs-C parity smoke test: runs cts2c-ensure-parity.ts over the blink_simple
// firmware for a short 5M cycles on each architecture, checking the CRC32 of the
// core0 PC trace matches block for block.
//
// DISABLED BY DEFAULT — it transpiles the whole emulator and invokes gcc, so it is
// far too slow and too toolchain-dependent (needs gcc and a writable build/) to run
// in the normal `npx vitest run`. Enable it explicitly:
//
//   CTS2C_PARITY=1 npx vitest run cts2c
//
// This only guards against gross regressions. The real check is the full-length run
// (400M cycles across all three demos, including riscv_pio_blink) — 5M cycles gets
// through boot and a few LED toggles, nothing more. Run that by hand before trusting
// a cts2c change:
//
//   npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_blink/blink_simple.hex 400000000 riscv
const ENABLED = process.env.CTS2C_PARITY === '1';

// `describe.skip` rather than a bare `if`, so the suite is reported as skipped instead
// of vanishing — a silently absent test looks identical to a passing one.
const describeParity = ENABLED ? describe : describe.skip;

const ROOT = join(__dirname, '..');
const CYCLES = 5_000_000;
const SCRIPT = 'cts2c/cts2c-ensure-parity.ts';

// gcc + a full transpile of src/ dominates the runtime; the comparison itself is well
// under a second per architecture.
const BUILD_TIMEOUT_MS = 240_000;
const RUN_TIMEOUT_MS = 120_000;

function runParity(hexFile: string, coreArch: 'riscv' | 'arm', skipBuild: boolean) {
  return execFileSync('npx', ['tsx', SCRIPT, hexFile, String(CYCLES), coreArch], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(skipBuild ? { CTS2C_SKIP_BUILD: '1' } : {}) },
  });
}

describeParity('cts2c Node-vs-C parity (blink_simple, 5M cycles)', () => {
  // Build once here rather than letting each case rebuild identical output. Done by
  // running the RISC-V case with the build enabled, so the build commands live in one
  // place (the script) instead of being duplicated here.
  let riscvOutput = '';

  beforeAll(() => {
    riscvOutput = runParity('demo/riscv_blink/blink_simple.hex', 'riscv', false);
  }, BUILD_TIMEOUT_MS);

  test('RISC-V blink_simple matches Node', () => {
    // The script exits non-zero on divergence, so reaching here already means it
    // passed. Assert on the PASS line too: it once reported PASS while the C harness
    // was actually crashing (see the comment above runC), so a zero exit code alone is
    // not sufficient evidence.
    expect(riscvOutput).toMatch(/^PASS: all \d+ CRC32 blocks match$/m);
  });

  test(
    'ARM blink_simple matches Node',
    () => {
      const out = runParity('demo/m33_blink/blink_simple.hex', 'arm', true);
      expect(out).toMatch(/^PASS: all \d+ CRC32 blocks match$/m);
    },
    RUN_TIMEOUT_MS
  );
});
