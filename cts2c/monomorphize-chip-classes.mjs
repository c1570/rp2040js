// Class-level ChipType monomorphization (source preprocessing pass for cts2c.js).
//
// cts2c.js's existing ChipType monomorphization covers free functions only; classes
// are unconditionally RP2350. That's fine for classes used by one chip, but several
// classes (RPUART/RPI2C/RPPWM/RPADC/RPSPI/RPTimer/RPWatchdog/etc.) are constructed by
// BOTH rp2040.ts and rp2350.ts. With ChipType hardcoded to RP2350, `this.rpchip.<f>`
// accesses would read RP2350 offsets from RP2040-laid-out memory — silent corruption.
//
// Rather than thread a class-type override through all of cts2c's class emission, this
// duplicates shared classes as a text-level pass before cts2c runs. Three modes:
//  - 'shared': original declaration stays (still represents RP2350); append one clone
//    per class with ChipType/sibling refs rewritten to the mangled `X__RP2040` name.
//  - 'rp2040-only': class is constructed only by rp2040.ts, so cts2c's RP2350 default
//    is wrong — rewrite in place (keep the name, resolve ChipType to RP2040).
//  - 'redirect-constructors': not a declaration site (e.g. rp2040.ts); whole-word
//    rename each named class ref to its __RP2040 clone.
//
// Output is passed to cts2c.js via `--shadow-dir`, since cts2c rediscovers files by
// walking src/ from disk (not the CLI list), so shadow-dir redirects content read for
// a given src/-rooted path rather than substituting paths.

import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const FILES = [
  { file: 'src/peripherals/peripheral.ts', classes: ['BasePeripheral'], mode: 'shared' },
  { file: 'src/peripherals/uart.ts', classes: ['RPUART'], mode: 'shared' },
  { file: 'src/peripherals/i2c.ts', classes: ['RPI2C'], mode: 'shared' },
  { file: 'src/peripherals/spi.ts', classes: ['RPSPI'], mode: 'shared' },
  { file: 'src/peripherals/watchdog.ts', classes: ['RPWatchdog'], mode: 'shared' },
  { file: 'src/peripherals/rtc.ts', classes: ['RP2040RTC'], mode: 'rp2040-only' },
  { file: 'src/peripherals/timer.ts', classes: ['RPTimerAlarm', 'RPTimer'], mode: 'shared' },
  {
    file: 'src/peripherals/adc.ts',
    classes: ['ADCSampleAlarm', 'ADCMultiShotAlarm', 'RPADC'],
    mode: 'shared',
  },
  {
    file: 'src/peripherals/pwm.ts',
    classes: [
      'PWMChannelAAlarmCallback',
      'PWMChannelBAlarmCallback',
      'PWMChannelBottomAlarmCallback',
      'PWMChannel',
      'RPPWM',
    ],
    mode: 'shared',
  },
  { file: 'src/peripherals/ppb.ts', classes: ['RPPPB'], mode: 'rp2040-only' },
  { file: 'src/peripherals/syscfg.ts', classes: ['RP2040SysCfg'], mode: 'rp2040-only' },
  // ChipType-generic but constructed ONLY by rp2040.ts (rp2350.ts has separate,
  // differently-named RP2350DMA/RP2350IO/RP2350PADS classes). Same cts2c-defaults-
  // to-RP2350 bug as RP2040RTC/RPPPB/RP2040SysCfg.
  { file: 'src/peripherals/dma.ts', classes: ['RPDMAChannel', 'RPDMA'], mode: 'rp2040-only' },
  { file: 'src/peripherals/io.ts', classes: ['RPIO'], mode: 'rp2040-only' },
  { file: 'src/peripherals/pads.ts', classes: ['RPPADS'], mode: 'rp2040-only' },
  { file: 'src/peripherals/sysinfo.ts', classes: ['RP2040SysInfo'], mode: 'rp2040-only' },
  { file: 'src/peripherals/ssi.ts', classes: ['RPSSI'], mode: 'rp2040-only' },
  // Rest of the "shared" group. Even classes with no own `this.rpchip.<f>` access
  // are affected: BasePeripheral's debug/info/warn/error read it, so an unfixed
  // subclass is wrong via inheritance.
  { file: 'src/gpio-pin.ts', classes: ['GPIOPin'], mode: 'shared' },
  { file: 'src/peripherals/busctrl.ts', classes: ['RPBUSCTRL'], mode: 'shared' },
  { file: 'src/peripherals/reset.ts', classes: ['RPReset'], mode: 'shared' },
  { file: 'src/peripherals/tbman.ts', classes: ['RPTBMAN'], mode: 'shared' },
  { file: 'src/peripherals/clocks.ts', classes: ['RPClocks'], mode: 'shared' },
  {
    file: 'src/peripherals/pio.ts',
    classes: ['IrqTarget', 'StateMachine', 'RPPIO'],
    mode: 'shared',
  },
  {
    file: 'src/peripherals/usb.ts',
    classes: ['USBEndpointAlarm', 'RPUSBController'],
    mode: 'shared',
  },
  // Shared, but not found by the top-level `new X(` scan: RPSIOCore is constructed
  // from within sio.ts/sio_rp2350.ts, not directly by rp2040.ts/rp2350.ts.
  { file: 'src/sio-core.ts', classes: ['RPSIOCore'], mode: 'shared' },
  {
    file: 'src/sio.ts',
    classes: ['RPSIOCore'],
    mode: 'redirect-constructors',
  },
  // Not a declaration site (see module comment): whole-word rename of top-level
  // shared classes rp2040.ts constructs (nested helpers are built by their parent's
  // constructor, not rp2040.ts). StateMachine is referenced by name for the
  // pioActiveSms typed-array field, not constructed here.
  {
    file: 'src/rp2040.ts',
    classes: [
      'RPUART',
      'RPI2C',
      'RPPWM',
      'RPADC',
      'RPSPI',
      'RPTimer',
      'RPWatchdog',
      'GPIOPin',
      'RPBUSCTRL',
      'RPReset',
      'RPTBMAN',
      'RPClocks',
      'RPPIO',
      'RPUSBController',
      'StateMachine',
    ],
    mode: 'redirect-constructors',
  },
];

// Declaration files (excludes 'redirect-constructors' entries, which don't declare
// anything). Substitution is global across all family names, not scoped per-file.
const DECL_FILES = FILES.filter((f) => f.mode !== 'redirect-constructors');
const ALL_FAMILY_NAMES = DECL_FILES.flatMap((f) => f.classes);
// Only 'shared' classes get an __RP2040 clone — 'rp2040-only' sibling references
// (e.g. RPDMAChannel -> RPDMA) must stay bare, so those passes use SHARED_FAMILY_NAMES.
const SHARED_FAMILY_NAMES = DECL_FILES.filter((f) => f.mode === 'shared').flatMap((f) => f.classes);

const TARGET_TYPE = 'RP2040'; // the only type ever cloned/rewritten
const CHIP_TYPE_GENERIC_CLAUSE = /<ChipType(?:\s+extends\s+IRPChip)?(?:\s*=\s*IRPChip)?>/g;
const BARE_CHIP_TYPE = /\bChipType\b/g;

/**
 * Rewrite a span's text to the RP2040 clone: drop the <ChipType> clause, replace
 * bare ChipType with RP2040, and mangle each family name to X__RP2040.
 * 'shared' passes ALL_FAMILY_NAMES; 'rp2040-only' passes SHARED_FAMILY_NAMES so
 * same-mode sibling refs stay bare.
 */
function renameSpanForType(text, names) {
  const familyRe = new RegExp(`\\b(${names.join('|')})\\b`, 'g');
  return text
    .replace(CHIP_TYPE_GENERIC_CLAUSE, '')
    .replace(BARE_CHIP_TYPE, TARGET_TYPE)
    .replace(familyRe, (name) => `${name}__${TARGET_TYPE}`);
}

function findClassSpans(source, classNames) {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
    ranges: true,
    loc: false,
  });
  const wanted = new Set(classNames);
  const spans = [];
  for (const node of ast.program.body) {
    let cls = node;
    if (cls.type === 'ExportNamedDeclaration') cls = cls.declaration;
    // TSInterfaceDeclaration too: a plain interface holding a family-class field
    // (pio.ts's IrqTarget) needs the same clone, or the field stays stuck on one chip.
    if (
      (cls?.type === 'ClassDeclaration' || cls?.type === 'TSInterfaceDeclaration') &&
      wanted.has(cls.id?.name)
    ) {
      // node.start/end (not cls.start/end) so `export` is included in the span.
      spans.push({ name: cls.id.name, start: node.start, end: node.end });
    }
  }
  const missing = classNames.filter((n) => !spans.some((s) => s.name === n));
  if (missing.length) {
    throw new Error(`monomorphize-chip-classes: class(es) not found: ${missing.join(', ')}`);
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Returns a Map from original absolute file path to transformed source text, for
 * every file in FILES that appears in `inputFiles`. Write these under a directory and
 * pass it to cts2c.js as `--shadow-dir`.
 */
export function monomorphizeChipClasses(inputFiles) {
  const out = new Map();
  for (const { file, classes, mode } of FILES) {
    const abs = inputFiles.find((f) => f.endsWith(file));
    if (!abs) continue; // this file isn't part of the current transpile — skip it
    const source = readFileSync(abs, 'utf8');

    if (mode === 'redirect-constructors') {
      // Whole-word rename every reference — not just `new X(`, but type annotations
      // like `Array<GPIOPin>` too, which must agree with the renamed constructor.
      const nameRe = new RegExp(`\\b(${classes.join('|')})\\b`, 'g');
      out.set(
        abs,
        source.replace(nameRe, (name) => `${name}__${TARGET_TYPE}`)
      );
      continue;
    }

    const spans = findClassSpans(source, classes);

    if (mode === 'shared') {
      // Original text is unchanged (keeps representing RP2350); append one renamed clone per class.
      let clones = '';
      for (const span of spans) {
        clones +=
          '\n' + renameSpanForType(source.slice(span.start, span.end), ALL_FAMILY_NAMES) + '\n';
      }
      out.set(
        abs,
        `${source}\n// ─── RP2040 clone(s), monomorphized from the class(es) above ───${clones}`
      );
    } else {
      // rp2040-only: rewrite in place, keeping the name but resolving
      // ChipType/BasePeripheral to the RP2040 clone instead of the RP2350 default.
      let rewritten = '';
      let cursor = 0;
      for (const span of spans) {
        rewritten += source.slice(cursor, span.start);
        rewritten += renameSpanForType(source.slice(span.start, span.end), SHARED_FAMILY_NAMES);
        cursor = span.end;
      }
      rewritten += source.slice(cursor);
      out.set(abs, rewritten);
    }
  }
  return out;
}
