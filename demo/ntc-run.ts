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

const hex_files = [homedir + '/project/connomore64/PicoDVI/software/build/apps/cnm64_main/cnm64_main.hex',
                   homedir + '/project/connomore64/PicoDVI/software/build/apps/cnm64_vic/cnm64_vic.hex',
                   homedir + '/project/connomore64/PicoDVI/software/build/apps/cnm64_output/cnm64_output.hex'];

const pin_gpio: number[] = [2,3,4,5,6,7,8,9,10];
const pin_label: string[] = ["clock", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"];

const mcu = new Array(hex_files.length).fill(null).map(() => new RP2040());

for(let i = 0; i < hex_files.length; i++) {
  mcu[i].loadBootrom(bootromB1);
  loadHex(fs.readFileSync(hex_files[i], 'utf-8'), mcu[i].flash, 0x10000000);
  mcu[i].core0.PC = 0x10000000;
  mcu[i].core1.PC = 0x10000000;
  mcu[i].core1.waiting = true;
  mcu[i].uart[0].onByte = (value) => { process.stdout.write(new Uint8Array([value])); };
}

const mcu_main = mcu[0];
const mcu_vic = mcu[1];
const mcu_output = mcu[2];

function getVarOffs(map_file: string, var_name: string) : number {
  const filename = homedir + '/project/connomore64/PicoDVI/software/build/apps/' + map_file;
  const content = fs.readFileSync(filename, 'utf-8');
  const search = var_name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const re = new RegExp(search + ".*\n *(0x[0-9a-f]+) ");
  const res = re.exec(content);
  if(res == null) throw new Error(`Could not find offset of variable ${var_name} in map file ${filename}`);
  return parseInt(res[1]);
}

/*
export enum GPIOPinState {
  Low,
  High,
  Input,
  InputPullUp,
  InputPullDown,
}
*/

let pin_state_inp: number[][] = new Array(hex_files.length).fill(null).map(() => new Array(pin_gpio.length).fill(3)); // all start in input pullup mode
let pin_state_res: number[] = new Array(pin_gpio.length).fill(0); // pipelined result pin state

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
  const stateMap = [0b01, 0b10, 0b00, 0b00, 0b00]; // Low, High, Input, InputPullUp, InputPullDown
  // TODO implement pullup etc.

  for(let i = 0; i < pin_label.length; i++) {
    let all_inputs = 1;
    let v_in = 0;
    for(let mcu_id = 0; mcu_id < hex_files.length; mcu_id++) {
      const pin_state = stateMap[pin_state_inp[mcu_id][i]];
      v_in |= pin_state;
      if(pin_state <= 1) all_inputs = 0;
    }

    if(all_inputs) v_in = (pin_state_res[i] >> (latency*2))&0b11; // all are inputs: just keep state (TODO pullup after some time or similar)

    pin_state_res[i] = pin_state_res[i] | (v_in << ((latency+1)*2));

    let v_old = pin_state_res[i] & 0b11;
    pin_state_res[i] = pin_state_res[i] >> 2;
    let v_new = pin_state_res[i] & 0b11;
    if(v_old != v_new) { //xxx TODO GPIO outputs should probably read back their output as input without latency, but this eats a lot of emulator performance
      const tfv = (v_new & 0b01) == 0;
      const gpio_pin = pin_gpio[i];
      for(let mcu_id = 0; mcu_id < hex_files.length; mcu_id++) mcu[mcu_id].gpio[gpio_pin].setInputValue(tfv);
    }

    // const conflict = (v_new == 0b11); // TODO
    // TODO VCD writing
  }
}

// Fast pin wiring implementation. Zero latency between writes and reads.
function fastPinListener(mcu_id: number, pin: number) {
  throw new Error("old and broken");
  return (state: GPIOPinState, oldState: GPIOPinState) => {
    pin_state_inp[mcu_id][pin] = state;
    const v: number = ((pin_state_inp[0][pin]===0)||(pin_state_inp[1][pin]===0))?0:1;
    const gpio_pin = pin_gpio[pin];
    const tfv = (v===1);
    mcu[0].gpio[gpio_pin].setInputValue(tfv);
    mcu[1].gpio[gpio_pin].setInputValue(tfv);
    mcu[2].gpio[gpio_pin].setInputValue(tfv);

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
  for(let mcu_id = 0; mcu_id < hex_files.length; mcu_id++) {
    mcu[mcu_id].gpio[pin_gpio[i]].addListener(usePinListener(mcu_id, i));
  }
}

for(let i = 11; i < 30; i++) {
  mcu_main.gpio[i].setInputValue(true);
}

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
    //const pixel = palette[mcu1.readUint8(framebuffer_off + i)];  // framebuffer in VIC
    const pixel = mcu_output.readUint8(framebuffer_off + i);  // framebuffer in OUTPUT
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
class MainLoopStats { startCycle: number = 0; duration: number = 0; idle: number = 0; idle2: number = 0; vic_h: number = 0; vic_l: number = 0; addr6510: number = 0; cycle6510: number = 0; }
let main_loop_stats: MainLoopStats[] = [];
let main_idle_cycles = 0;
let main_idle2_cycles = 0;
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
let vic_idle_cycles = 0;
let render_idle_cycles = 0;
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
  let mcu_cycles_behind = new Array(hex_files.length).fill(0);
  let pio_cycles_behind = new Array(hex_files.length).fill(0);

  const colLen = 18;
  let logs: string[] = [];
  let pTags: string[] = ["", "", "", ""];
  const tagContinue = "...".padEnd(colLen);

  function log_state() {
    const cpu_addr = mcu_main.readUint16(cpu_addr_off);
    let wTags: string[] = [];
    const pTags_updated: string[] = [mcu_main.core0.profilerTag, mcu_main.core1.profilerTag, mcu_vic.core0.profilerTag, mcu_vic.core1.profilerTag,
                                     mcu_main.pio[0].machines[0].pc.toString(), mcu_vic.pio[1].machines[0].pc.toString(), mcu_vic.pio[1].machines[1].pc.toString(), mcu_output.pio[1].machines[0].pc.toString()];
    const pInstrs: number[] = [0, 0, 0, 0, mcu_main.pio[0].instructions[mcu_main.pio[0].machines[0].pc],
                                           mcu_vic.pio[1].instructions[mcu_vic.pio[1].machines[0].pc],
                                           mcu_vic.pio[1].instructions[mcu_vic.pio[1].machines[1].pc],
                                           mcu_output.pio[1].instructions[mcu_output.pio[1].machines[0].pc]];
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
    if(mcu_main.core0.cycles==main_cycle_start_at) {
      cycleTag = mcu_main.core0.cycles.toString().padStart(10, " ");
    } else {
      cycleTag = ("+" + ((mcu_main.core0.cycles - main_cycle_start_at).toString())).padStart(10, " ");
    }
    let busTag = (((mcu_main.core0.cycles - bus_cycle_start_at).toString())).padStart(3, " ");
    let bus_state_str = bus_state>=0 ? bus_state_labels[bus_state] : "---";
    let bus_pins = "";
    let bus_bin = 0;
    for(let i = 8; i > 0; i--) { let bus_pin = (mcu_output.gpio[pin_gpio[i]].status>>17)&1; bus_bin = (bus_bin<<1) + bus_pin; bus_pins = bus_pins + bus_pin.toString(); }
    bus_pins = ((mcu_output.gpio[pin_gpio[0]].status>>17)&1).toString() + " " + bus_pins;
    logs.push(`${cycleTag} / ${busTag} | ${bus_state_str} | M ${mcu_main.core0.PC.toString(16).padStart(8,"0")}/${wTags[0]} ${mcu_main.core1.PC.toString(16).padStart(8,"0")}/${wTags[1]} | V ${mcu_vic.core0.PC.toString(16).padStart(8,"0")}/${wTags[2]} ${mcu_vic.core1.PC.toString(16).padStart(8,"0")}/${wTags[3]} | M_PIO@${wTags[4]} V_PIO@${wTags[5]}/r${mcu_vic.pio[1].machines[0].rxFIFO.itemCount}/t${mcu_vic.pio[1].machines[0].txFIFO.itemCount} V_OUT@${wTags[6]} O_INP@${wTags[7]} | V_H_COUNT@${vic_h.toString().padStart(2,"0")} 6510@${cpu_addr.toString(16).padStart(4,"0")} ${bus_pins} ${bus_bin.toString(16).padStart(2,"0")}`);
  }

  try {
  for (let i = 0; i < 1000000; i++) {
      if(mcu[0].core0.cycles>next_cycle_time_output) {
        write_pic("/tmp/cnm64.gif");
        next_cycle_time_output += 4000000;
        console.log(`clock: ${((mcu[0].core0.cycles/40000000)>>>0)/10} secs`);
      }

      // run mcu0 for one step, take note of how many cycles that took...
      gpio_cycle = mcu[0].core0.cycles;
      let cycles_consumed = mcu[0].stepCores();
      pio_cycles_behind[0] += cycles_consumed;
      if(mcu[0].core0.profilerTag.startsWith("*")) main_idle_cycles += cycles_consumed;
      if(mcu[0].core1.profilerTag.startsWith("*")) main_idle2_cycles += cycles_consumed;

      // ...then step other mcus until they caught up.
      for(let mcu_id = 1; mcu_id < hex_files.length; mcu_id++) {
        const cycles_for_mcu = (mcu_id != 2) ? cycles_consumed : (cycles_consumed*(295/400)); // mcu_output runs at 295 instead of 400MHz
        mcu_cycles_behind[mcu_id] += cycles_for_mcu;
        pio_cycles_behind[mcu_id] += cycles_for_mcu;
        while(mcu_cycles_behind[mcu_id] > 0) {
          let cycles_mcu = mcu[mcu_id].stepCores();
          mcu_cycles_behind[mcu_id] -= cycles_mcu;
          if(mcu_id == 1) {
            // some VIC logging
            if(mcu[1].core0.profilerTag.startsWith("*")) vic_idle_cycles += cycles_mcu;
            if(mcu[1].core1.profilerTag.startsWith("*")) render_idle_cycles += cycles_mcu;
            if(vic_cycle_state!=0 && mcu[1].core0.profilerTag=="^vic tick") {
              vic_cycle_state = 0;
              vic_cycle_start_at = mcu[1].core0.cycles;
            } else if(vic_cycle_state!=1 && mcu[1].core0.profilerTag=="$vic tick") {
              vic_cycle_state = 1;
              //if((vic_idle_cycles<30)||(render_idle_cycles<20)) // ********
                vic_loop_stats.push({startCycle: vic_cycle_start_at, duration: mcu[1].core0.cycles-vic_cycle_start_at, vic_h: vic_h, vic_l: vic_l, cycle6510: cycles_6510, idle: vic_idle_cycles, idle2: render_idle_cycles, addr6510:0});
              vic_idle_cycles = 0; render_idle_cycles = 0;
              if(vic_loop_stats.length>100000) vic_loop_stats=vic_loop_stats.slice(vic_loop_stats.length-max_len_vic_loop_stats);
            }
          }
        }
      }

      // now, let PIOs catch up - done separately from MCU cores to reduce jitter
      for(let pCycles = 0; pCycles < cycles_consumed; pCycles++) {
        // bus state debug output handling, look at clock pin
        let cur_clock_pin_state = (mcu[2].gpio[pin_gpio[0]].status>>17)&1;
        if(cur_clock_pin_state != clock_pin_state) {
          if(cur_clock_pin_state == 1) {
            bus_state = (bus_state + 1) % 5;
            if(bus_state==0) bus_cycle_start_at = gpio_cycle;
          }
          clock_pin_state = cur_clock_pin_state;
        }

        // tick PIOs
        for(let mcu_id = 0; mcu_id < hex_files.length; mcu_id++) {
          if(pio_cycles_behind[mcu_id] > 0) {
            pio_cycles_behind[mcu_id] -= 1;
            mcu[mcu_id].stepPios(1);
          }
        }

        // check for PIO stalls
        let pio_fdebug = mcu[0].pio[0].fdebug;
        if(pio_fdebug & 0x0f0f0f00) {
          //if(pio_fdebug & 0x0f000000) throw new Error(`MAIN PIO TX STALL: ${(pio_fdebug>>24)&15}`);
          if(pio_fdebug & 0x000f0000) throw new Error(`MAIN PIO TX OVERFLOW: ${(pio_fdebug>>16)&15}`);
          if(pio_fdebug & 0x00000f00) throw new Error(`MAIN PIO RX UNDERFLOW: ${(pio_fdebug>>8)&15}`);
        }
        pio_fdebug = mcu[1].pio[1].fdebug;
        if(pio_fdebug & 0x0f0f0f00) {
          if(pio_fdebug & 0x0f000000) throw new Error(`VIC PIO TX STALL IN SM ${(pio_fdebug>>24)&15}`);
          if(pio_fdebug & 0x000f0000) throw new Error(`VIC PIO TX OVERFLOW IN SM ${(pio_fdebug>>16)&15}`);
          if(pio_fdebug & 0x00000f00) throw new Error(`VIC PIO RX UNDERFLOW IN SM ${(pio_fdebug>>8)&15}`);
        }

        if(!useFastPinListener) exactPinTick();
        gpio_cycle++;
      }

      if((main_cycle_start_off==0)&&(mcu[0].core0.profilerTag=="cycle start")) {
        main_cycle_start_off=mcu[0].core0.PC;
        main_cycle_start_at = mcu[0].core0.cycles;
      } else if(mcu[0].core0.PC==main_cycle_start_off) {
        //if(main_idle2_cycles < 20) // ***************
        //if((mcu[0].core0.cycles-main_cycle_start_at) > 410 && (mcu[0].core0.cycles-main_cycle_start_at) < 450) // ***************
          main_loop_stats.push({startCycle: main_cycle_start_at, duration: mcu[0].core0.cycles-main_cycle_start_at, idle: main_idle_cycles, idle2: main_idle2_cycles, vic_h: vic_h, vic_l: vic_l, addr6510: mcu[0].readUint16(cpu_addr_off), cycle6510: cycles_6510});
        cycles_6510++; main_idle_cycles = 0; main_idle2_cycles = 0;
        if(main_loop_stats.length>100000) main_loop_stats=main_loop_stats.slice(main_loop_stats.length-max_len_main_loop_stats);
        vic_h++; if(vic_h > 62) { vic_h = 0; vic_l++; if(vic_l >= 312) vic_l = 0; }
        main_cycle_start_at = mcu[0].core0.cycles;
      } else if(mcu[0].core0.profilerTag=="_quit") throw new Error("Debug encountered _quit");

      if(do_tracing) {
        log_state();
        if(debug_crash_cycle>0 && mcu[0].core0.cycles>debug_crash_cycle) throw new Error("Debug end tracing");
      } else {
        if(debug_crash_cycle>0 && mcu[0].core0.cycles>(debug_crash_cycle-10000)) do_tracing = true;
        if(debug_trace_from_emu_cycle>0 && cycles_6510>debug_trace_from_emu_cycle) { do_tracing = true; debug_crash_cycle = mcu[0].core0.cycles + 4200; }
        if(debug_trace_from_emu_addr>0 && mcu[0].readUint16(cpu_addr_off)==debug_trace_from_emu_addr) { do_tracing = true; debug_crash_cycle = mcu[0].core0.cycles + 4200; }
      }
      if(got_sigint) throw new Error("caught sigint");

      if(trace_6510_file || trace_6510_file_it) {
        let addr_6510 = mcu[0].readUint16(cpu_addr_off);
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
    logs.push(`*** Exception ${e} - try running with CNM64_RUN_TO_CYCLE=${mcu[0].core0.cycles} ***`);
    log_state();
    if(logs.length>5000) logs=logs.slice(logs.length-5000);
    console.error(logs.join("\n"));
    vcd_file.destroy();
    if(trace_6510_file) {
      trace_6510_file.destroy();
      write_pic(trace_6510_filename + ".gif");
    }
    fs.writeFileSync("/tmp/rp2040_crash.bin", Buffer.from(mcu[0].sram));
    console.error("\n*** 6510 statistics ***");
    if(main_loop_stats.length>max_len_main_loop_stats) main_loop_stats=main_loop_stats.slice(main_loop_stats.length-max_len_main_loop_stats);
    for(let l of main_loop_stats) {
      console.error(`6510 cycle ${l.cycle6510}, ARM cycle ${l.startCycle}, MAIN total/idle ${l.duration}/${l.idle} cycles, core1 idle ${l.idle2} cycles, bus addr ${l.addr6510.toString(16).padStart(4,"0")}, vic_l ${l.vic_l}, vic_h ${l.vic_h}`);
    }
    console.error("\n*** VIC-II statistics ***");
    if(vic_loop_stats.length>max_len_vic_loop_stats) vic_loop_stats=vic_loop_stats.slice(vic_loop_stats.length-max_len_vic_loop_stats);
    for(let l of vic_loop_stats) {
      console.error(`6510 cycle ${l.cycle6510}, ARM cycle ${l.startCycle}, VIC tick/idle ${l.duration}/${l.idle} cycles, render idle ${l.idle2} cycles, vic_l ${l.vic_l}, vic_h ${l.vic_h}`);
    }
    write_pic("/tmp/cnm64.gif");
    process.exit(e.message.startsWith("Debug ")?0:1);
  }
}

run_mcus();
