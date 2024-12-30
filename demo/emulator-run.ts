import * as fs from 'fs';
import { RP2040 } from '../src';
import { bootromB1 } from './bootrom';
import { loadHex } from './intelhex';
import { GDBTCPServer } from '../src/gdb/gdb-tcp-server';

const homedir = require('os').homedir();

const hex = fs.readFileSync('demo/riscv_blink/blink_simple.hex', 'utf-8');
const mcu = new RP2040();
mcu.loadBootrom(bootromB1);
//loadHex(hex, mcu.flash, 0x20000000);
loadHex(hex, mcu.sram, 0x20000000);

//const gdbServer = new GDBTCPServer(mcu, 3333);
//console.log(`RP2040 GDB Server ready! Listening on port ${gdbServer.port}`);

mcu.uart[0].onByte = (value) => {
  process.stdout.write(new Uint8Array([value]));
};

mcu.core0.pc = 0x20000220; //TODO why?
mcu.core1.pc = 0x20000000;
//mcu.core1.waiting = true; //TODO
while(1) {
  mcu.step();
}
