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

let cycle: number = 0;
let pins: GPIOPinState[] = [0,0,0,0,0,0,0,0];

function pinClkListener(state: GPIOPinState, oldState: GPIOPinState) {
  if(state===1) {
    console.log("Clock high at cycle " + cycle);
    let v = (pins[0]==GPIOPinState.Low?0:1) +
            (pins[1]==GPIOPinState.Low?0:2) +
            (pins[2]==GPIOPinState.Low?0:4) +
            (pins[3]==GPIOPinState.Low?0:8) +
            (pins[4]==GPIOPinState.Low?0:16) +
            (pins[5]==GPIOPinState.Low?0:32) +
            (pins[6]==GPIOPinState.Low?0:64) +
            (pins[7]==GPIOPinState.Low?0:128);
    //console.log("value: " + v.toString(16));
  }
}

function pinListener(pin: number) {
  return (state: GPIOPinState, oldState: GPIOPinState) => { pins[pin] = state; };
}

mcu1.gpio[2].addListener(pinClkListener);
mcu1.gpio[3].addListener(pinListener(0));
mcu1.gpio[4].addListener(pinListener(1));
mcu1.gpio[5].addListener(pinListener(2));
mcu1.gpio[6].addListener(pinListener(3));
mcu1.gpio[7].addListener(pinListener(4));
mcu1.gpio[8].addListener(pinListener(5));
mcu1.gpio[9].addListener(pinListener(6));
mcu1.gpio[10].addListener(pinListener(7));

mcu1.core.PC = 0x10000000;
mcu2.core.PC = 0x10000000;

function run_mcus() {
  for (let i = 0; i < 100000; i++) {
      cycle++;
      if((cycle%(1<<20))===0) console.log(cycle);
      mcu1.step();
      mcu2.step();
  }
  setTimeout(() => run_mcus(), 0);
}

run_mcus();
