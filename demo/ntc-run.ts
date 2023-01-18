import * as fs from 'fs';
import { RP2040 } from '../src';
import { GPIOPinState } from '../src/gpio-pin';
import { bootromB1 } from './bootrom';
import { loadHex } from './intelhex';
import { GDBTCPServer } from '../src/gdb/gdb-tcp-server';

// Create an array with the compiled code of blink
// Execute the instructions from this array, one by one.
const hex1 = fs.readFileSync('/home/mayne/project/PicoDVI/software/build/apps/ntc64_main/ntc64_main.hex', 'utf-8');
const hex2 = fs.readFileSync('/home/mayne/project/PicoDVI/software/build/apps/ntc64_vic/ntc64_vic.hex', 'utf-8');

const mcu1 = new RP2040();
const mcu2 = new RP2040();
mcu1.loadBootrom(bootromB1);
mcu2.loadBootrom(bootromB1);
loadHex(hex1, mcu1.flash, 0x10000000);
loadHex(hex2, mcu2.flash, 0x10000000);

const gdbServer = new GDBTCPServer(mcu1, 3333);
console.log(`RP2040-1 GDB Server ready! Listening on port ${gdbServer.port}`);

mcu1.uart[0].onByte = (value) => {
  process.stdout.write(new Uint8Array([value]));
};

mcu2.uart[0].onByte = (value) => {
  process.stdout.write(new Uint8Array([value]));
};

/*
export enum GPIOPinState {
  Low,
  High,
  Input,
  InputPullUp,
  InputPullDown,
}
*/

let pin_state: GPIOPinState[][] = [[3,3,3,3,3,3,3,3,3,3], [3,3,3,3,3,3,3,3,3,3]]; // all in input pullup mode
let pin_name: string[] = ["clock", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "vic_ack"];
let pin_id: string[] = ["!", "§", "$", "%", "&", "/", "(", ")", "=", "*"];
let vcd_file = fs.createWriteStream('/tmp/ntc64rp2040.vcd', {});

function pinListener(mcu_id: number, pin: number) {
  return (state: GPIOPinState, oldState: GPIOPinState) => {
    pin_state[mcu_id][pin] = state;
    let v: number = ((pin_state[0][pin]===0)||(pin_state[1][pin]===0))?0:1; //TODO handle collisions/high

    mcu1.gpio[pin+2].setInputValue((v==1)?true:false);
    mcu2.gpio[pin+2].setInputValue((v==1)?true:false);

    vcd_file.write(`#${mcu1.core.cycles} ${v}${pin_id[pin]}\n`);
  };
}

for(let i = 0; i < pin_name.length; i++) {
  mcu1.gpio[i+2].addListener(pinListener(0, i));
  mcu2.gpio[i+2].addListener(pinListener(1, i));
}

mcu1.core.PC = 0x10000000;
mcu2.core.PC = 0x10000000;

vcd_file.write("$timescale 1ns $end\n");
vcd_file.write("$scope module logic $end\n");
for(let i = 0; i < pin_name.length; i++) {
  vcd_file.write(`$var wire 1 ${pin_id[i]} ${pin_name[i]} $end\n`);
}
vcd_file.write("$upscope $end\n");
vcd_file.write("$enddefinitions $end");

function run_mcus() {
  for (let i = 0; i < 100000; i++) {
      if((mcu1.core.cycles%(1<<21))===0) console.log(`wall clock: ${mcu1.core.cycles/300000000} secs`);
      mcu1.step();
      mcu2.step();
  }
  setTimeout(() => run_mcus(), 0);
}

run_mcus();
