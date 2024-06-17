const vcd_enabled = false;
const useFastPinListener = false;
let debug_crash_cycle = parseInt(process.env.CNM64_RUN_TO_CYCLE || "0");
const debug_trace_from_emu_cycle = parseInt(process.env.CNM64_TRACE_FROM_EMU_CYCLE || "0");
const debug_trace_from_emu_addr = parseInt(process.env.CNM64_TRACE_FROM_EMU_ADDR || "0");
let trace_6510_filename = process.env.CNM64_TRACE_6510; //CNM64_FINISH_WITH_TRACE to exit(0) on trace validation end

const max_len_main_loop_stats = 1000;
const max_len_vic_loop_stats = 1000;

const GIFEncoder = require('gifencoder');
const { createCanvas, loadImage } = require('canvas');
const readline = require('readline');

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

function getVarOffs(map_file: string, var_name: string) : number {
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

let pin_state_inp: number[][] = [[3,3,3,3,3,3,3,3,3,3,3,3,3], [3,3,3,3,3,3,3,3,3,3,3,3,3]]; // all start in input pullup mode
let pin_state_res: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0];
const pin_gpio: number[] = [2,3,4,5,6,7,8,9,10,11,0,1,24];
const pin_label: string[] = ["clock", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "vic_ack", "iec_clk", "iec_data", "iec_atn"];
let vcd_file = fs.createWriteStream('/tmp/cnm64rp2040.vcd', {});
let last_conflict_cycle: number = -1;

let gpio_cycle: number = 0;

// Pin wiring implementation that implements latency but is slower.
function exactPinListener(mcu_id: number, pin: number) {
  return (state: GPIOPinState, oldState: GPIOPinState) => {
    pin_state_inp[mcu_id][pin] = state;
  }
}

function exactPinTick() {
  const latency = 7; // measured at 400MHz
  const stateMap = [0b01, 0b10, 0b00, 0b00, 0b00]; // TODO implement pullup etc.

  for(let i = 0; i < pin_label.length; i++) {
    const inp0 = pin_state_inp[0][i];
    const inp1 = pin_state_inp[1][i];
    let v_in = stateMap[inp0] | stateMap[inp1];
    if(inp0>1 && inp1>1) v_in = (pin_state_res[i] >> (latency*2))&0b11; // both inputs: just keep state (TODO pullup after some time or similar)

    pin_state_res[i] = pin_state_res[i] | (v_in << ((latency+1)*2));

    let v_old = pin_state_res[i] & 0b11;
    pin_state_res[i] = pin_state_res[i] >> 2;
    let v_new = pin_state_res[i] & 0b11;
    if(v_old != v_new) { //xxx TODO GPIO outputs should probably read back their output as input without latency, but this eats a lot of emulator performance
      const tfv = (v_new & 0b01) == 0;
      const gpio_pin = pin_gpio[i];
      //xxx if(pin_state_inp[0][i]>1) mcu1.gpio[gpio_pin].setInputValue(tfv); else mcu1.gpio[gpio_pin].setInputValue(pin_state_inp[0][i]==1);
      //xxx if(pin_state_inp[1][i]>1) mcu2.gpio[gpio_pin].setInputValue(tfv); else mcu2.gpio[gpio_pin].setInputValue(pin_state_inp[1][i]==1);
      mcu1.gpio[gpio_pin].setInputValue(tfv);
      mcu2.gpio[gpio_pin].setInputValue(tfv);
      mcu3.gpio[gpio_pin].setInputValue(tfv);
    } //xxx

    // const conflict = (v_new == 0b11); // TODO
    // TODO VCD writing
  }
}

// Fast pin wiring implementation. Zero latency between writes and reads.
function fastPinListener(mcu_id: number, pin: number) {
  return (state: GPIOPinState, oldState: GPIOPinState) => {
    pin_state_inp[mcu_id][pin] = state;
    const v: number = ((pin_state_inp[0][pin]===0)||(pin_state_inp[1][pin]===0))?0:1;
    const gpio_pin = pin_gpio[pin];
    const tfv = (v===1);
    mcu1.gpio[gpio_pin].setInputValue(tfv);
    mcu2.gpio[gpio_pin].setInputValue(tfv);
    mcu3.gpio[gpio_pin].setInputValue(tfv);

    // write signal to VCD file
    if(pin_state_res[pin]!==v) {
      pin_state_res[pin]=v;
      if(vcd_enabled) {
        let pin_vcd_id = String.fromCharCode(pin+34);
        vcd_file.write(`#${gpio_cycle} ${v}${pin_vcd_id}\n`);
      }
    }

    if(vcd_enabled) {
      // write conflict flag to VCD file
      const conflict: boolean = ((pin_state_inp[0][pin]===0)&&(pin_state_inp[1][pin]===1))||((pin_state_inp[0][pin]===1)&&(pin_state_inp[1][pin]===0));
      //if(conflict) console.log(`Conflict on pin ${pin_label[pin]} at cycle ${gpio_cycle} (${pin_state_inp[0][pin]}/${pin_state_inp[1][pin]})`);
      const have_new_conflict = conflict&&(last_conflict_cycle === -1);
      const conflict_recently_resolved = (!conflict)&&(last_conflict_cycle !== -1);
      if(conflict_recently_resolved && (gpio_cycle === last_conflict_cycle)) {
        // one mcu set conflict and other resolved in same cycle:
        // delay until next signal change so that the conflict signal is visible in VCD
        return;
      }
      const write_conflict_flag: boolean = have_new_conflict || conflict_recently_resolved;
      if(write_conflict_flag) {
        vcd_file.write(`#${gpio_cycle} ${conflict?1:0}!\n`);
      }
      last_conflict_cycle = conflict ? gpio_cycle : -1;
    }
  };
}

for(let i = 0; i < pin_label.length; i++) {
  const usePinListener = useFastPinListener ? fastPinListener : exactPinListener;
  if(i != 9) mcu1.gpio[pin_gpio[i]].addListener(usePinListener(0, i)); // MAIN is source for all GPIOs but vic_ack
  if(i <= 9) mcu2.gpio[pin_gpio[i]].addListener(usePinListener(1, i)); // VIC is source for bus GPIOs and vic_ack only
  // OUTPUT is not source for any GPIOs
}

for(let i = 11; i < 30; i++) {
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

const cpu_addr_off = getVarOffs("cnm64_main/cnm64_main.elf.map", ".bss.addr");
const framebuffer_off = getVarOffs("cnm64_output/cnm64_output.elf.map", ".bss.frame_buffer");

function write_pic(filename: string) {
  const width = 400;
  const height = 300;
  const palette = [0x00,0xff,0x84,0x7b,0x86,0x55,0x26,0xfd,0x88,0x44,0xcd,0x49,0x6d,0xbe,0x6f,0xb6];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const encoder = new GIFEncoder(width, height);
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
  const buf = encoder.out.getData();
  fs.writeFileSync(`${filename}_new`, buf);
  fs.renameSync(`${filename}_new`, filename);
}

const bus_state_labels: string[] = ["p1 ", "p2a", "p2b", "p3 ", "p4 "];
let bus_state = -1;

const tagCycleStart = "cycle start";
let main_cycle_start_off = 0;
class MainLoopStats { startCycle: number = 0; duration: number = 0; idle: number = 0; vic_h: number = 0; vic_l: number = 0; addr6510: number = 0; cycle6510: number = 0; }
let main_loop_stats: MainLoopStats[] = [];
let main_cycle_start_at = 0;
let bus_cycle_start_at = 0;
let cycles_6510 = 0;
let do_tracing = false;

let trace_6510_file: any = null;
let trace_6510_file_it: any = null;
if(trace_6510_filename != undefined) {
  if(fs.existsSync(trace_6510_filename)) {
    const rl = readline.createInterface({input: fs.createReadStream(trace_6510_filename, {})});
    trace_6510_file_it = rl[Symbol.asyncIterator]();
  } else {
    trace_6510_file = fs.createWriteStream(trace_6510_filename, {});
  }
}

let vic_loop_stats: MainLoopStats[] = [];
let vic_cycle_start_at = 0;
let vic_cycle_state = -1;
let vic_h = 0;
let vic_l = 0;

let clock_pin_state = 0;

let next_cycle_time_output = 0;

let addr_6510_last = -1;
let trace_6510_step = 0;

let got_sigint = false;
process.on('SIGINT', () => {got_sigint = true;});

async function run_mcus() {
  let cycles_mcu2_behind = 0;
  let cycles_mcu3_behind = 0;
  const colLen = 18;
  let logs: string[] = [];
  let pTags: string[] = ["", "", "", ""];
  const tagContinue = "...".padEnd(colLen);

  function log_state() {
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
    if(mcu1.core0.cycles==main_cycle_start_at) {
      cycleTag = mcu1.core0.cycles.toString().padStart(10, " ");
    } else {
      cycleTag = ("+" + ((mcu1.core0.cycles - main_cycle_start_at).toString())).padStart(10, " ");
    }
    let busTag = (((mcu1.core0.cycles - bus_cycle_start_at).toString())).padStart(3, " ");
    let bus_state_str = bus_state>=0 ? bus_state_labels[bus_state] : "---";
    let bus_pins = "";
    let bus_bin = 0;
    for(let i = 8; i > 0; i--) { let bus_pin = (mcu3.gpio[pin_gpio[i]].status>>17)&1; bus_bin = (bus_bin<<1) + bus_pin; bus_pins = bus_pins + bus_pin.toString(); }
    bus_pins = ((mcu3.gpio[pin_gpio[0]].status>>17)&1).toString() + " " + bus_pins;
    logs.push(`${cycleTag} / ${busTag} | ${bus_state_str} | M ${mcu1.core0.PC.toString(16).padStart(8,"0")}/${wTags[0]} ${mcu1.core1.PC.toString(16).padStart(8,"0")}/${wTags[1]} | V ${mcu2.core0.PC.toString(16).padStart(8,"0")}/${wTags[2]} ${mcu2.core1.PC.toString(16).padStart(8,"0")}/${wTags[3]} | M_PIO@${wTags[4]} V_PIO@${wTags[5]}/r${mcu2.pio[1].machines[0].rxFIFO.itemCount}/t${mcu2.pio[1].machines[0].txFIFO.itemCount} V_OUT@${wTags[6]} O_INP@${wTags[7]} | V_H_COUNT@${vic_h.toString().padStart(2,"0")} 6510@${cpu_addr.toString(16).padStart(4,"0")} ${bus_pins} ${bus_bin.toString(16).padStart(2,"0")}`);
  }

  let mcu3_pio_cycles_behind = 0;
  try {
  for (let i = 0; i < 1000000; i++) {
      if(mcu1.core0.cycles>next_cycle_time_output) {
        write_pic("/tmp/cnm64.gif");
        next_cycle_time_output += 4000000;
        console.log(`clock: ${((mcu1.core0.cycles/40000000)>>>0)/10} secs`);
      }

      // run mcu1 for one step, take note of how many cycles that took,
      // then step mcu2 and mcu3 until they caught up.
      gpio_cycle = mcu1.core0.cycles;
      let cycles = mcu1.stepCores();
      cycles_mcu2_behind += cycles;
      let mcu3_cycles = cycles*(295/400);
      cycles_mcu3_behind += mcu3_cycles;
      mcu3_pio_cycles_behind += mcu3_cycles;
      while(cycles_mcu2_behind > 0) {
        //console.log("MCU2");
        cycles_mcu2_behind -= mcu2.stepCores();

        if(vic_cycle_state!=0 && mcu2.core0.profilerTag=="^vic tick") {
          vic_cycle_state = 0;
          vic_cycle_start_at = mcu2.core0.cycles;
        } else if(vic_cycle_state!=1 && mcu2.core0.profilerTag=="$vic tick") {
          vic_cycle_state = 1;
          vic_loop_stats.push({startCycle: vic_cycle_start_at, duration: mcu2.core0.cycles-vic_cycle_start_at, vic_h: vic_h, vic_l: vic_l, cycle6510: cycles_6510, idle:0, addr6510:0});
          if(vic_loop_stats.length>100000) vic_loop_stats=vic_loop_stats.slice(vic_loop_stats.length-max_len_vic_loop_stats);
        }
      }
      while(cycles_mcu3_behind > 0) {
        //console.log("MCU3");
        cycles_mcu3_behind -= mcu3.stepCores();
      }

      // now, let PIOs catch up - done separately from MCU cores to reduce jitter
      for(let pCycles = 0; pCycles < cycles; pCycles++) {
        let cur_clock_pin_state = (mcu3.gpio[pin_gpio[0]].status>>17)&1;
        if(cur_clock_pin_state != clock_pin_state) {
          if(cur_clock_pin_state == 1) {
            bus_state = (bus_state + 1) % 5;
            if(bus_state==0) bus_cycle_start_at = gpio_cycle;
          }
          clock_pin_state = cur_clock_pin_state;
        }
        mcu1.stepPios(1);
        mcu2.stepPios(1);
        let pio_fdebug = mcu1.pio[0].fdebug;
        if(pio_fdebug & 0x0f0f0f00) {
          if(pio_fdebug & 0x0f000000) throw new Error(`MAIN PIO TX STALL: ${(pio_fdebug>>24)&15}`);
          if(pio_fdebug & 0x000f0000) throw new Error(`MAIN PIO TX OVERFLOW: ${(pio_fdebug>>16)&15}`);
          if(pio_fdebug & 0x00000f00) throw new Error(`MAIN PIO RX UNDERFLOW: ${(pio_fdebug>>8)&15}`);
        }
        pio_fdebug = mcu2.pio[1].fdebug;
        if(pio_fdebug & 0x0f0f0f00) {
          if(pio_fdebug & 0x0f000000) throw new Error(`VIC PIO TX STALL IN SM ${(pio_fdebug>>24)&15}`);
          if(pio_fdebug & 0x000f0000) throw new Error(`VIC PIO TX OVERFLOW IN SM ${(pio_fdebug>>16)&15}`);
          if(pio_fdebug & 0x00000f00) throw new Error(`VIC PIO RX UNDERFLOW IN SM ${(pio_fdebug>>8)&15}`);
        }
        if(mcu3_pio_cycles_behind > 0) {
          mcu3_pio_cycles_behind--;
          mcu3.stepPios(1);
        }
        if(!useFastPinListener) exactPinTick();
        gpio_cycle++;
      }

      if((main_cycle_start_off==0)&&(mcu1.core0.profilerTag=="cycle start")) {
        main_cycle_start_off=mcu1.core0.PC;
        main_cycle_start_at = mcu1.core0.cycles;
      } else if(mcu1.core0.PC==main_cycle_start_off) {
        main_loop_stats.push({startCycle: main_cycle_start_at, duration: mcu1.core0.cycles-main_cycle_start_at, idle: 0, vic_h: vic_h, vic_l: vic_l, addr6510: mcu1.readUint16(cpu_addr_off), cycle6510: cycles_6510++});
        if(main_loop_stats.length>100000) main_loop_stats=main_loop_stats.slice(main_loop_stats.length-max_len_main_loop_stats);
        vic_h++; if(vic_h > 62) { vic_h = 0; vic_l++; if(vic_l >= 311) vic_l = 0; }
        main_cycle_start_at = mcu1.core0.cycles;
      } else if(mcu1.core0.profilerTag=="_quit") throw new Error("Debug encountered _quit");

      if(do_tracing) {
        log_state();
        if(debug_crash_cycle>0 && mcu1.core0.cycles>debug_crash_cycle) throw new Error("Debug end tracing");
      } else {
        if(debug_crash_cycle>0 && mcu1.core0.cycles>(debug_crash_cycle-10000)) do_tracing = true;
        if(debug_trace_from_emu_cycle>0 && cycles_6510>debug_trace_from_emu_cycle) { do_tracing = true; debug_crash_cycle = mcu1.core0.cycles + 4200; }
        if(debug_trace_from_emu_addr>0 && mcu1.readUint16(cpu_addr_off)==debug_trace_from_emu_addr) { do_tracing = true; debug_crash_cycle = mcu1.core0.cycles + 4200; }
      }
      if(got_sigint) throw new Error("caught sigint");

      if(trace_6510_file || trace_6510_file_it) {
        let addr_6510 = mcu1.readUint16(cpu_addr_off);
        if(addr_6510 != addr_6510_last) {
          trace_6510_step++;
          if(trace_6510_file) {
            trace_6510_file.write(`${addr_6510.toString(16).padStart(4,"0")}\n`);
          } else {
            let line = await trace_6510_file_it.next();
            if(line.done) {
              console.log("Trace validation ended without mismatches.");
              write_pic(`${trace_6510_filename}.current.gif`);
              var tstBuf = fs.readFileSync(`${trace_6510_filename}.gif`);
              var curBuf = fs.readFileSync(`${trace_6510_filename}.current.gif`);
              if(curBuf.toString() !== tstBuf.toString()) throw new Error(`Video output differs after trace, see ${trace_6510_filename}.current.gif`);
              trace_6510_file_it=null;
              if(process.env.CNM64_FINISH_WITH_TRACE) process.exit(0);
            }
            else if(Number(`0x${line.value}`) != addr_6510) throw new Error(`6510 addr mismatch, expected ${line.value}, got ${addr_6510.toString(16).padStart(4,"0")}, step ${trace_6510_step}, tracefile ${trace_6510_filename}`);
          }
          addr_6510_last = addr_6510;
        }
      }
  }

  write_pic("/tmp/cnm64.gif");
  setTimeout(() => run_mcus(), 0);
  } catch(e) {
    logs.push(`*** Exception ${e} - try running with CNM64_RUN_TO_CYCLE=${mcu1.core0.cycles} ***`);
    log_state();
    if(logs.length>5000) logs=logs.slice(logs.length-5000);
    console.error(logs.join("\n"));
    vcd_file.destroy();
    if(trace_6510_file) {
      trace_6510_file.destroy();
      write_pic(trace_6510_filename + ".gif");
    }
    fs.writeFileSync("/tmp/rp2040_crash.bin", Buffer.from(mcu1.sram));
    console.error("\n*** 6510 statistics ***");
    if(main_loop_stats.length>max_len_main_loop_stats) main_loop_stats=main_loop_stats.slice(main_loop_stats.length-max_len_main_loop_stats);
    for(let l of main_loop_stats) {
      console.error(`6510 cycle ${l.cycle6510}, ARM cycle ${l.startCycle}, MAIN took ${l.duration} cycles, bus addr ${l.addr6510.toString(16).padStart(4,"0")}, vic_h ${l.vic_h}, vic_l ${l.vic_l}`);
    }
    console.error("\n*** VIC-II statistics ***");
    if(vic_loop_stats.length>max_len_vic_loop_stats) vic_loop_stats=vic_loop_stats.slice(vic_loop_stats.length-max_len_vic_loop_stats);
    for(let l of vic_loop_stats) {
      console.error(`6510 cycle ${l.cycle6510}, ARM cycle ${l.startCycle}, VIC tick took ${l.duration} cycles, vic_h ${l.vic_h}`);
    }
    write_pic("/tmp/cnm64.gif");
    process.exit(e.message.startsWith("Debug ")?0:1);
  }
}

run_mcus();
