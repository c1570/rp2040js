// CPU benchmark runner — TS emulator.
// Runs cpu_benchmark firmware on RP2040 / RP2350-ARM / RP2350-RISC-V,
// captures UART output (verifies checksum determinism), measures cycles/sec.
//
// Usage: npx tsx test/cpu_benchmark/run-bench.ts [targetCycles]
import { RP2040, RP2350 } from '../../src';
import { ConsoleLogger, LogLevel } from '../../src/utils/logging';

const targetCycles = parseInt(process.argv[2] || '200000000', 10);
const FW = {
  rp2040: 'test/cpu_benchmark/cpu_benchmark_rp2040.hex',
  arm: 'test/cpu_benchmark/cpu_benchmark_rp2350_arm.hex',
  riscv: 'test/cpu_benchmark/cpu_benchmark_rp2350_riscv.hex',
};

type Result = { lines: string[]; cyclesPerSec: number };

function runOne(label: string, coreArch: 'rp2040' | 'arm' | 'riscv'): Result {
  const mcu =
    coreArch === 'rp2040' ? new RP2040() : new RP2350({ coreArch: coreArch as 'arm' | 'riscv' });
  mcu.logger = new ConsoleLogger(LogLevel.Error, true);

  if (coreArch === 'rp2040') {
    // RP2040 bootrom boot is broken in the emulator; bypass it.
    mcu.loadFirmware(FW.rp2040, { entryPc: 0x10000000 });
    (mcu as RP2040).core[1].waiting = true;
  } else {
    mcu.loadFirmware(FW[coreArch]);
  }

  const lines: string[] = [];
  let buf = '';
  mcu.uart[0].onByte = (v: number) => {
    buf += String.fromCharCode(v);
    if (buf.endsWith('\n')) {
      const s = buf.trim();
      if (s.startsWith('iter=')) lines.push(s);
      buf = '';
    }
  };

  const t0 = Date.now();
  while (mcu.cycles < targetCycles) {
    mcu.step();
  }
  const elapsedMs = Date.now() - t0;
  const cyclesPerSec = elapsedMs > 0 ? (mcu.cycles / elapsedMs) * 1000 : 0;

  return { lines, cyclesPerSec };
}

const results: Record<string, Result> = {};
for (const label of ['rp2040', 'arm', 'riscv'] as const) {
  process.stderr.write(`Running ${label}... `);
  results[label] = runOne(label, label);
  process.stderr.write(`${results[label].lines.length} prints\n`);
}

process.stdout.write('\n=== TS Emulator Results ===\n\n');
for (const label of ['rp2040', 'arm', 'riscv'] as const) {
  const r = results[label];
  process.stdout.write(`${label}: ${Math.round(r.cyclesPerSec).toLocaleString()} cycles/sec\n`);
  for (const line of r.lines.slice(0, 3)) {
    process.stdout.write(`  ${line}\n`);
  }
  if (r.lines.length > 3) process.stdout.write(`  ... (${r.lines.length} total)\n`);
  process.stdout.write('\n');
}

// Output JSON for cross-comparison
process.stdout.write('---JSON---\n');
process.stdout.write(
  JSON.stringify({
    targetCycles,
    results: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [
        k,
        {
          lines: v.lines,
          cyclesPerSec: Math.round(v.cyclesPerSec),
        },
      ])
    ),
  }) + '\n'
);
