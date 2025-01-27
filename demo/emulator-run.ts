import * as fs from 'fs';
import { RP2350 } from '../src';
import { bootrom_rp2350_A2 } from './bootrom_rp2350';
import { loadHex } from './intelhex';
import { GDBTCPServer } from '../src/gdb/gdb-tcp-server';

const homedir = require('os').homedir();

const hex = fs.readFileSync('demo/riscv_blink/blink_simple.hex', 'utf-8');
const mcu = new RP2350();
mcu.loadBootrom(bootrom_rp2350_A2);
//loadHex(hex, mcu.flash, 0x20000000);
loadHex(hex, mcu.sram, 0x20000000);

const disassembly = fs.readFileSync('./demo/bootrom_rp2350.dis', 'utf-8') + fs.readFileSync('./demo/riscv_blink/blink_simple.dis');
mcu.loadDisassembly(disassembly);

//const gdbServer = new GDBTCPServer(mcu, 3333);
//console.log(`GDB Server ready! Listening on port ${gdbServer.port}`);

mcu.uart[0].onByte = (value: number) => {
  process.stdout.write(new Uint8Array([value]));
};

mcu.core0.pc = 0x20000220; //TODO why?
//mcu.core0.pc = 0x7642; // Bootrom riscv_entry_point
mcu.core1.pc = 0x20000220;
//mcu.core1.waiting = true;
while(1) {
  mcu.step();
}
