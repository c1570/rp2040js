const vcd_enabled = false;
const debug_crash_cycle = parseInt(process.env.CNM64_RUN_TO_CYCLE || "0");
const tracing_enabled = debug_crash_cycle>0;
const start_tracing_at_cycle = debug_crash_cycle - 10000;

const GIFEncoder = require('gifencoder');
const { createCanvas, loadImage } = require('canvas');

import * as fs from 'fs';
import { RP2040 } from '../src';
import { GPIOPinState } from '../src/gpio-pin';
import { bootromB1 } from './bootrom';
import { loadHex } from './intelhex';

const homedir = require('os').homedir();
const hex1 = fs.readFileSync(homedir + '/project/connomore64/PicoDVI/software/build/apps/cnm64_main/cnm64_main.hex', 'utf-8');
const hex2 = fs.readFileSync(homedir + '/project/connomore64/PicoDVI/software/build/apps/cnm64_vic/cnm64_vic.hex', 'utf-8');
const hex3 = fs.readFileSync(homedir + '/project/connomore64/PicoDVI/software/build/apps/cnm64_output/cnm64_output.hex', 'utf-8');
const mcu1 = new RP2040();
const mcu2 = new RP2040();
const mcu3 = new RP2040();
mcu1.loadBootrom(bootromB1);
mcu2.loadBootrom(bootromB1);
mcu3.loadBootrom(bootromB1);
loadHex(hex1, mcu1.flash, 0x10000000);
loadHex(hex2, mcu2.flash, 0x10000000);
loadHex(hex3, mcu3.flash, 0x10000000);

function getVarOffs(map_file: string, var_name: string) {
  const filename = homedir + '/project/connomore64/PicoDVI/software/build/apps/' + map_file;
  const content = fs.readFileSync(filename, 'utf-8');
  const search = var_name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const re = new RegExp(search + ".*\n *(0x[0-9a-f]+) ");
  const res = re.exec(content);
  if(res == null) throw new Error(`Could not find offset of variable ${var_name} in map file ${filename}`);
  return parseInt(res[1]);
}

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

let pin_state: number[][] = [[0,0,0,0,0,0,0,0,0,0,0,0,0],[3,3,3,3,3,3,3,3,3,3,3,3,3], [3,3,3,3,3,3,3,3,3,3,3,3,3]]; // all start in input pullup mode
let pin_gpio: number[] = [2,3,4,5,6,7,8,9,10,11,0,1,24];
let pin_label: string[] = ["clock", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "vic_ack", "iec_clk", "iec_data", "iec_atn"];
let vcd_file = fs.createWriteStream('/tmp/cnm64rp2040.vcd', {});
let last_conflict_cycle: number = -1;

function pinListener(mcu_id: number, pin: number) {
  return (state: GPIOPinState, oldState: GPIOPinState) => {
    pin_state[mcu_id+1][pin] = state;
    let v: number = ((pin_state[0+1][pin]===0)||(pin_state[1+1][pin]===0))?0:1;
    mcu1.gpio[pin+2].setInputValue((v==1)?true:false);
    mcu2.gpio[pin+2].setInputValue((v==1)?true:false);
    mcu3.gpio[pin+2].setInputValue((v==1)?true:false);

    // write signal to VCD file
    if(pin_state[0][pin]!==v) {
      pin_state[0][pin]=v;
      if(vcd_enabled) {
        let pin_vcd_id = String.fromCharCode(pin+34);
        vcd_file.write(`#${mcu1.core0.cycles} ${v}${pin_vcd_id}\n`);
      }
    }

    if(vcd_enabled) {
      // write conflict flag to VCD file
      let conflict: boolean = ((pin_state[0+1][pin]===0)&&(pin_state[1+1][pin]===1))||((pin_state[0+1][pin]===1)&&(pin_state[1+1][pin]===0));
      //if(conflict) console.log(`Conflict on pin ${pin_label[pin]} at cycle ${mcu1.core0.cycles} (${pin_state[0+1][pin]}/${pin_state[1+1][pin]})`);
      let have_new_conflict = conflict&&(last_conflict_cycle === -1);
      let conflict_recently_resolved = (!conflict)&&(last_conflict_cycle !== -1);
      if(conflict_recently_resolved && (mcu1.core0.cycles === last_conflict_cycle)) {
        // one mcu set conflict and other resolved in same cycle:
        // delay until next signal change so that the conflict signal is visible in VCD
        return;
      }
      let write_conflict_flag: boolean = have_new_conflict || conflict_recently_resolved;
      if(write_conflict_flag) {
        vcd_file.write(`#${mcu1.core0.cycles} ${conflict?1:0}!\n`);
      }
      last_conflict_cycle = conflict ? mcu1.core0.cycles : -1;
    }
  };
}

for(let i = 0; i < pin_label.length; i++) {
  if(i != 9) mcu1.gpio[pin_gpio[i]].addListener(pinListener(0, i)); // MAIN is source for all GPIOs but vic_ack
  if(i <= 9) mcu2.gpio[pin_gpio[i]].addListener(pinListener(1, i)); // VIC is source for bus GPIOs and vic_ack only
  // OUTPUT is not source for any GPIOs
}

for(let i = 11; i < 16; i++) {
  mcu1.gpio[i].setInputValue(true);
}

mcu1.core0.PC = 0x10000000;
mcu1.core1.PC = 0x10000000;
mcu1.core1.waiting = true;
mcu2.core0.PC = 0x10000000;
mcu2.core1.PC = 0x10000000;
mcu2.core1.waiting = true;
mcu3.core0.PC = 0x10000000;
mcu3.core1.PC = 0x10000000;
mcu3.core1.waiting = true;

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

const width = 400;
const height = 300;
const canvas = createCanvas(width, height);
const ctx = canvas.getContext('2d');
const palette = [0x00,0xff,0x84,0x7b,0x86,0x55,0x26,0xfd,0x88,0x44,0xcd,0x49,0x6d,0xbe,0x6f,0xb6];
const cpu_addr_off = getVarOffs("cnm64_main/cnm64_main.elf.map", ".bss.addr");
const framebuffer_off = getVarOffs("cnm64_output/cnm64_output.elf.map", ".bss.frame_buffer");
const vic_h_count_off = getVarOffs("cnm64_vic/cnm64_vic.elf.map", ".bss.vic_h_count");

function write_pic() {
  const encoder = new GIFEncoder(width, height);
  encoder.createReadStream().pipe(fs.createWriteStream('/tmp/_new_cnm64_gif'));
  encoder.start();
  //encoder.setRepeat(0);
  //encoder.setDelay(1000);
  encoder.setQuality(10);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < width*height; i++) {
    //const pixel = palette[mcu2.readUint8(framebuffer_off + i)];  // framebuffer in VIC
    const pixel = mcu3.readUint8(framebuffer_off + i);  // framebuffer in OUTPUT
    data[i*4+0] = (pixel&0b11100000)<<0;
    data[i*4+1] = (pixel&0b00011100)<<3;
    data[i*4+2] = (pixel&0b00000011)<<6;
    data[i*4+3] = 255;
  }
  data[0] = 255;
  ctx.putImageData(imageData, 0, 0);
  encoder.addFrame(ctx);
  encoder.finish();
  fs.rename('/tmp/_new_cnm64_gif', '/tmp/cnm64.gif', (err) => {});
}

const main_pio_state_str: string[] = ["p1 ", "p2a", "p2b", "p3 ", "p4 "];
let main_pio_state = -1;

const tagCycleStart = "cycle start";
let main_cycle_start_off = 0;
class MainLoopStats { startCycle: number = 0; duration: number = 0; idle: number = 0; vic_h: number = 0; }
let main_loop_stats: MainLoopStats[] = [];
let main_cycle_start_at = 0;

let got_sigint = false;
process.on('SIGINT', () => {got_sigint = true;});

function run_mcus() {
  let cycles_mcu2_behind = 0;
  let cycles_mcu3_behind = 0;
  const colLen = 18;
  let logs: string[] = [];
  let pTags: string[] = ["", "", "", ""];
  const tagContinue = "...".padEnd(colLen);

  function log_state() {
    const vic_h_count = mcu2.readUint32(vic_h_count_off);
    const cpu_addr = mcu1.readUint16(cpu_addr_off);
    let wTags: string[] = [];
    const pTags_updated: string[] = [mcu1.core0.profilerTag, mcu1.core1.profilerTag, mcu2.core0.profilerTag, mcu2.core1.profilerTag,
                                     mcu1.pio[0].machines[0].pc.toString(), mcu2.pio[1].machines[0].pc.toString(), mcu2.pio[1].machines[1].pc.toString(), mcu3.pio[1].machines[0].pc.toString()];
    const pInstrs: number[] = [0, 0, 0, 0, mcu1.pio[0].instructions[mcu1.pio[0].machines[0].pc],
                                           mcu2.pio[1].instructions[mcu2.pio[1].machines[0].pc],
                                           mcu2.pio[1].instructions[mcu2.pio[1].machines[1].pc],
                                           mcu3.pio[1].instructions[mcu3.pio[1].machines[0].pc]];
    for(let i = 0; i < 4; i++) {
      const tag = pTags_updated[i];
      wTags.push(tag==pTags[i]?tagContinue:tag.padEnd(colLen));
    }
    for(let i = 4; i < 8; i++) {
      const tag = pTags_updated[i];
      let instrAnn = " ";
      const opcPar = pInstrs[i]&0b1110000011100000;
      if(opcPar==0b0100000000000000) instrAnn = "i"; // IN PINS
      else if(opcPar==0b0110000000000000) instrAnn = "o"; // OUT PINS
      else if(opcPar==0b0110000010000000) instrAnn = "d"; // OUT PINDIRS
      wTags.push(tag==pTags[i]?"~~ ":(tag.padStart(2,"0")+instrAnn));
    }
    pTags = pTags_updated;
    let cycleTag = "";
    if(mcu1.core0.PC==main_cycle_start_off) {
      cycleTag = mcu1.core0.cycles.toString().padStart(10, " ");
    } else {
      cycleTag = ("+" + ((mcu1.core0.cycles - main_cycle_start_at).toString())).padStart(10, " ");
    }
    logs.push(`${cycleTag} | M ${mcu1.core0.PC.toString(16).padStart(8,"0")}/${wTags[0]} ${mcu1.core1.PC.toString(16).padStart(8,"0")}/${wTags[1]} | V ${mcu2.core0.PC.toString(16).padStart(8,"0")}/${wTags[2]} ${mcu2.core1.PC.toString(16).padStart(8,"0")}/${wTags[3]} | M_PIO@${wTags[4]}/${main_pio_state_str[main_pio_state]} V_PIO@${wTags[5]}/${mcu2.pio[1].machines[0].rxFIFO.itemCount} V_OUT@${wTags[6]} O_INP@${wTags[7]} | V_H_COUNT@${vic_h_count.toString().padStart(2,"0")} 6510@${cpu_addr.toString(16).padStart(4,"0")}`);
  }

  let mcu3_pio_cycles_behind = 0;
  try {
  for (let i = 0; i < 1000000; i++) {
      if((mcu1.core0.cycles%(1<<25))===0) console.log(`clock: ${mcu1.core0.cycles/400000000} secs`);

      // run mcu1 for one step, take note of how many cycles that took,
      // then step mcu2 and mcu3 until they caught up.
      //console.log("MCU1");
      let cycles = mcu1.stepCores();
      //if(mcu1.core0.cycles>15000000) if(cycles>2) console.log(`cycles MCU1: ${cycles}`);
      cycles_mcu2_behind += cycles;
      let mcu3_cycles = cycles*(295/400);
      cycles_mcu3_behind += mcu3_cycles;
      mcu3_pio_cycles_behind += mcu3_cycles;
      while(cycles_mcu2_behind > 0) {
        //console.log("MCU2");
        cycles_mcu2_behind -= mcu2.stepCores();
      }
      while(cycles_mcu3_behind > 0) {
        //console.log("MCU3");
        cycles_mcu3_behind -= mcu3.stepCores();
      }

      // now, let PIOs catch up - done separately from MCU cores to reduce jitter
      for(let pCycles = 0; pCycles < cycles; pCycles++) {
        if(mcu1.pio[0].machines[0].pc==1) main_pio_state = (main_pio_state + 1) % 5; // out PC
        mcu1.stepPios(1);
        mcu2.stepPios(1);
        if(mcu2.pio[1].fdebug & 0x0f0f0f00) {
          if(mcu2.pio[1].fdebug & 0x0f000000) throw new Error(`VIC PIO TX STALL: ${(mcu2.pio[1].fdebug>>24)&15}`);
          if(mcu2.pio[1].fdebug & 0x000f0000) throw new Error(`VIC PIO TX OVERFLOW: ${(mcu2.pio[1].fdebug>>16)&15}`);
          if(mcu2.pio[1].fdebug & 0x00000f00) throw new Error(`VIC PIO RX UNDERFLOW: ${(mcu2.pio[1].fdebug>>8)&15}`);
        }
        if(mcu3_pio_cycles_behind > 0) {
          mcu3_pio_cycles_behind--;
          mcu3.stepPios(1);
        }
      }

      if((main_cycle_start_off==0)&&(mcu1.core0.profilerTag=="cycle start")) {
        main_cycle_start_off=mcu1.core0.PC;
        main_cycle_start_at = mcu1.core0.cycles;
      } else if(mcu1.core0.PC==main_cycle_start_off) {
        main_loop_stats.push({startCycle: main_cycle_start_at, duration: mcu1.core0.cycles-main_cycle_start_at, idle: 0, vic_h: mcu2.readUint32(vic_h_count_off)});
        main_cycle_start_at = mcu1.core0.cycles;
      }
      if(tracing_enabled && (mcu1.core0.cycles > start_tracing_at_cycle)) log_state();
      if(got_sigint) throw new Error("caught sigint");
      if(debug_crash_cycle>0 && mcu1.core0.cycles>debug_crash_cycle) throw new Error("Debug crash");
  }

  write_pic();
  setTimeout(() => run_mcus(), 0);
  } catch(e) {
    logs.push(`*** Exception ${e} - try running with CNM64_RUN_TO_CYCLE=${mcu1.core0.cycles} ***`);
    log_state();
    if(logs.length>5000) logs=logs.slice(logs.length-5000);
    console.error(logs.join("\n"));
    vcd_file.destroy();
    fs.writeFileSync("/tmp/rp2040_crash.bin", Buffer.from(mcu1.sram));
    console.error("\n*** Statistics ***");
    if(main_loop_stats.length>100) main_loop_stats=main_loop_stats.slice(main_loop_stats.length-50);
    for(let l of main_loop_stats) {
      console.error(`${l.startCycle} took ${l.duration} cycles, vic_h ${l.vic_h}`);
    }
    write_pic();
    throw e;
  }
}

run_mcus();
