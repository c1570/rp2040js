import * as fs from 'fs';
import { RP2040 } from '../src';
import { GPIOPinState } from '../src/gpio-pin';
import { bootromB1 } from './bootrom';
import { loadHex } from './intelhex';

const hex1 = fs.readFileSync('/home/mayne/project/PicoDVI/software/build/apps/ntc64_main/ntc64_main.hex', 'utf-8');
const hex2 = fs.readFileSync('/home/mayne/project/PicoDVI/software/build/apps/ntc64_vic/ntc64_vic.hex', 'utf-8');
const mcu1 = new RP2040();
const mcu2 = new RP2040();
mcu1.loadBootrom(bootromB1);
mcu2.loadBootrom(bootromB1);
loadHex(hex1, mcu1.flash, 0x10000000);
loadHex(hex2, mcu2.flash, 0x10000000);

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

let pin_state: number[][] = [[0,0,0,0,0,0,0,0,0,0,0,0],[3,3,3,3,3,3,3,3,3,3,3,3], [3,3,3,3,3,3,3,3,3,3,3,3]]; // all start in input pullup mode
let pin_gpio: number[] = [2,3,4,5,6,7,8,9,10,11,16,28];
let pin_label: string[] = ["clock", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "ack", "main_busy", "vic_busy"];
let vcd_file = fs.createWriteStream('/tmp/ntc64rp2040.vcd', {});
let last_conflict_cycle: number = -1;

function pinListener(mcu_id: number, pin: number) {
  return (state: GPIOPinState, oldState: GPIOPinState) => {
    pin_state[mcu_id+1][pin] = state;
    let v: number = ((pin_state[0+1][pin]===0)||(pin_state[1+1][pin]===0))?0:1;
    mcu1.gpio[pin+2].setInputValue((v==1)?true:false);
    mcu2.gpio[pin+2].setInputValue((v==1)?true:false);

    // write signal to VCD file
    let pin_vcd_id = String.fromCharCode(pin+34);
    if(pin_state[0][pin]!==v) {
      pin_state[0][pin]=v;
      vcd_file.write(`#${mcu1.core.cycles} ${v}${pin_vcd_id}\n`);
    }

    // write conflict flag to VCD file
    let conflict: boolean = ((pin_state[0+1][pin]===0)&&(pin_state[1+1][pin]===1))||((pin_state[0+1][pin]===1)&&(pin_state[1+1][pin]===0));
    if(conflict) console.log(`Conflict on pin ${pin_label[pin]} at cycle ${mcu1.core.cycles} (${pin_state[0+1][pin]}/${pin_state[1+1][pin]})`);
    let have_new_conflict = conflict&&(last_conflict_cycle === -1);
    let conflict_recently_resolved = (!conflict)&&(last_conflict_cycle !== -1);
    if(conflict_recently_resolved && (mcu1.core.cycles === last_conflict_cycle)) {
      // one mcu set conflict and other resolved in same cycle:
      // delay until next signal change so that the conflict signal is visible in VCD
      return;
    }
    let write_conflict_flag: boolean = have_new_conflict || conflict_recently_resolved;
    if(write_conflict_flag) {
      vcd_file.write(`#${mcu1.core.cycles} ${conflict?1:0}!\n`);
    }
    last_conflict_cycle = conflict ? mcu1.core.cycles : -1;
  };
}

for(let i = 0; i < pin_label.length; i++) {
  if((pin_label[i] != "ack")&&(pin_label[i] != "vic_busy")) mcu1.gpio[pin_gpio[i]].addListener(pinListener(0, i));
  if(pin_label[i] != "main_busy") mcu2.gpio[pin_gpio[i]].addListener(pinListener(1, i));
}

for(let i = 11; i < 16; i++) {
  mcu1.gpio[i].setInputValue(true);
}

mcu1.core.PC = 0x10000000;
mcu2.core.PC = 0x10000000;

// write VCD file header
vcd_file.write("$timescale 1ns $end\n");
vcd_file.write("$scope module logic $end\n");
vcd_file.write(`$var wire 1 ! bus_conflict $end\n`);
for(let pin = 0; pin < pin_label.length; pin++) {
  let pin_vcd_id = String.fromCharCode(pin+34);
  vcd_file.write(`$var wire 1 ${pin_vcd_id} ${pin_label[pin]} $end\n`);
}
vcd_file.write("$upscope $end\n");
vcd_file.write("$enddefinitions $end\n");

function run_mcus() {
  for (let i = 0; i < 100000; i++) {
      if((mcu1.core.cycles%(1<<25))===0) console.log(`clock: ${mcu1.core.cycles/300000000} secs`);
      mcu1.step();
      mcu2.step();
  }
  setTimeout(() => run_mcus(), 0);
}

run_mcus();
