import * as fs from 'fs';
import { RP2040 } from '../src';
import { GPIOPinState } from '../src/gpio-pin';
import { bootromB1 } from './bootrom';
import { loadHex } from './intelhex';
import { GDBTCPServer } from '../src/gdb/gdb-tcp-server';

// Create an array with the compiled code of blink
// Execute the instructions from this array, one by one.
const hex1 = fs.readFileSync('/home/mayne/project/PicoDVI/software/build/apps/ntc64_main/ntc64_main.hex', 'utf-8');
const hex2 = fs.readFileSync('hello_uart.hex', 'utf-8');

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

let pin_state: GPIOPinState[] = [0,0,0,0,0,0,0,0,0];
let pin_name: string[] = ["clock", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"];
let pin_id: string[] = ["!", "§", "$", "%", "&", "/", "(", ")", "="];

function pinListener(pin: number) {
  return (state: GPIOPinState, oldState: GPIOPinState) => {
    let v: number = (state===GPIOPinState.Low)?0:1;
    console.log("#"+mcu1.core.cycles+` ${v}`+pin_id[pin]);
    pin_state[pin] = state;
    mcu1.gpio[pin+2].setInputValue((v==1)?true:false);
  };
}

mcu1.gpio[2].addListener(pinListener(0));
mcu1.gpio[3].addListener(pinListener(1));
mcu1.gpio[4].addListener(pinListener(2));
mcu1.gpio[5].addListener(pinListener(3));
mcu1.gpio[6].addListener(pinListener(4));
mcu1.gpio[7].addListener(pinListener(5));
mcu1.gpio[8].addListener(pinListener(6));
mcu1.gpio[9].addListener(pinListener(7));
mcu1.gpio[10].addListener(pinListener(8));

mcu1.core.PC = 0x10000000;
mcu2.core.PC = 0x10000000;

console.log("$timescale 1ns $end");
console.log("$scope module logic $end");
for(let i = 0; i < 9; i++) {
  console.log(`$var wire 1 ${pin_id[i]} ${pin_name[i]} $end`);
}
console.log("$upscope $end");
console.log("$enddefinitions $end");

function run_mcus() {
  for (let i = 0; i < 100000; i++) {
      //if((mcu1.core.cycles%(1<<20))===0) console.log(mcu1.core.cycles);
      mcu1.step();
      mcu2.step();
  }
  setTimeout(() => run_mcus(), 0);
}

run_mcus();
