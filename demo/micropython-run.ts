import { RP2040 } from '../src';
import { Simulator } from '../src/simulator';
import { GDBTCPServer } from '../src/gdb/gdb-tcp-server';
import { ArmGDBServer } from '../src/gdb/arm-gdb-server';
import { USBCDC } from '../src/usb/cdc';
import { ConsoleLogger, LogLevel } from '../src/utils/logging';
import { loadMicropythonFlashImage, loadCircuitpythonFlashImage } from './load-flash';
import fs from 'fs';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2), {
  string: [
    'image', // UF2 image to load; defaults to "RPI_PICO-20230426-v1.20.0.uf2"
    'expect-text', // Text to expect on the serial console, process will exit with code 0 if found
  ],
  boolean: [
    'gdb', // start GDB server on 3333
    'circuitpython', // use CircuitPython instead of MicroPython
  ],
});
const expectText = args['expect-text'];

const simulator = new Simulator(new RP2040());
const mcu = simulator.rpchip;
mcu.logger = new ConsoleLogger(LogLevel.Error);

let imageName: string;
if (!args.circuitpython) {
  imageName = args.image ?? 'RPI_PICO-20230426-v1.20.0.uf2';
} else {
  imageName = args.image ?? 'adafruit-circuitpython-raspberry_pi_pico-en_US-8.0.2.uf2';
}
console.log(`Loading uf2 image ${imageName}`);
// Load UF2 with initChip=false so we can layer a filesystem image onto flash
// before the chip reset runs.
mcu.loadFirmware(imageName, { initChip: false });

if (fs.existsSync('littlefs.img') && !args.circuitpython) {
  console.log(`Loading uf2 image littlefs.img`);
  loadMicropythonFlashImage('littlefs.img', mcu);
} else if (fs.existsSync('fat12.img') && args.circuitpython) {
  loadCircuitpythonFlashImage('fat12.img', mcu);
  // Instead of reading from file, it would also be possible to generate the LittleFS image on-the-fly here, e.g. using
  // https://github.com/wokwi/littlefs-wasm or https://github.com/littlefs-project/littlefs-js
}

// Now reset so the cores start at the bootrom reset vector and run the
// normal flash scan on the next step().
mcu.reset();

if (args.gdb) {
  const gdbServer = new GDBTCPServer(new ArmGDBServer(simulator), 3333);
  console.log(`RP2040 GDB Server ready! Listening on port ${gdbServer.port}`);
}

const cdc = new USBCDC(mcu.usbCtrl);
cdc.onDeviceConnected = () => {
  if (!args.circuitpython) {
    // We send a newline so the user sees the MicroPython prompt
    cdc.sendSerialByte('\r'.charCodeAt(0));
    cdc.sendSerialByte('\n'.charCodeAt(0));
  } else {
    cdc.sendSerialByte(3);
  }
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

simulator.rpchip.core0.PC = 0x10000000;
simulator.execute();
