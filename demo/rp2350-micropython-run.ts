import { RP2350, CoreArch } from '../src';
import { USBCDC } from '../src/usb/cdc';
import { ConsoleLogger, LogLevel } from '../src/utils/logging';
import { loadMicropythonFlashImage } from './load-flash';
import fs from 'fs';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2), {
  string: ['image', 'expect-text'],
  boolean: ['gdb'],
});
const expectText = args['expect-text'];

const coreArch = (process.env['RP2350_CORE_ARCH'] || 'riscv') as CoreArch;
if (coreArch !== 'arm' && coreArch !== 'riscv') {
  throw new Error(`RP2350_CORE_ARCH=${coreArch} must be "arm" or "riscv"`);
}

const mcu = new RP2350({ coreArch });
mcu.logger = new ConsoleLogger(LogLevel.Info);

mcu.uart[0].onByte = (value: number) => {
  process.stdout.write(new Uint8Array([value]));
};

const imageName =
  args.image ??
  (coreArch === 'arm'
    ? './demo/RPI_PICO2-20260406-v1.28.0.uf2'
    : './demo/RPI_PICO2-RISCV-20260406-v1.28.0.uf2');
console.log(`Loading uf2 image ${imageName}`);
// Load UF2 with initChip=false so we can layer the littlefs image onto flash
// before the bootrom handoff / chip reset runs.
mcu.loadFirmware(imageName, { initChip: false });

if (fs.existsSync('littlefs.img')) {
  console.log(`Loading littlefs image littlefs.img`);
  loadMicropythonFlashImage('littlefs.img', mcu);
}

// Now initialise the chip: bootrom scans flash for the IMAGE_DEF and hands
// off to firmware on the next step().
mcu.reset();

const cdc = new USBCDC(mcu.usbCtrl);
cdc.onDeviceConnected = () => {
  cdc.sendSerialByte('\r'.charCodeAt(0));
  cdc.sendSerialByte('\n'.charCodeAt(0));
};

let currentLine = '';
cdc.onSerialData = (value, length) => {
  process.stdout.write(value.subarray(0, length));

  for (const byte of value.subarray(0, length)) {
    const char = String.fromCharCode(byte);
    if (char === '\n') {
      if (expectText && currentLine.includes(expectText)) {
        console.log(`Expected text found: "${expectText}"`);
        console.log('TEST PASSED.');
        process.exit(0);
      }
      currentLine = '';
    } else {
      currentLine += char;
    }
  }
};

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.on('data', (chunk) => {
  // 24 is Ctrl+X
  if (chunk[0] === 24) {
    process.exit(0);
  }
  for (const byte of chunk) {
    cdc.sendSerialByte(byte);
  }
});

// Bounded batches yield to the event loop (cf. Simulator.execute()); a plain
// `while (1) { mcu.step(); }` would starve stdout flushing and stdin input.
function runBatch() {
  for (let i = 0; i < 1_000_000; i++) {
    mcu.step();
  }
  setImmediate(runBatch);
}
runBatch();
