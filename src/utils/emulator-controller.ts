/**
 * EmulatorController — reusable engine that exposes RP2350 emulator state
 * and control via a `handleToolCall(name, args)` tool-call interface.
 *
 * Tools: read/write registers and memory, set breakpoints and tracepoints,
 * single-step, run, load/reset firmware, inspect PIO/GPIO state, dump
 * memory regions to files, and convert between decimal and hex.
 *
 * This is the engine consumed by both transports:
 *   - `src/rp2-emu-cli/` — `rp2_emu` CLI + unix-socket daemon.
 *   - `src/mcp/mcp-server.ts` — thin MCP (Model Context Protocol) shim that
 *     wraps `EmulatorController.createServer()`.
 *
 * Value conventions:
 *   - All register values, addresses, and offsets in tool *outputs* are
 *     formatted as zero-padded hex strings (e.g. "0x20000222").
 *   - All integer *inputs* accept a JSON number, a decimal string, or a
 *     "0x"-prefixed hex string (case-insensitive); see parseUint().
 *
 * Usage:
 *   const ctrl = new EmulatorController();
 *   const result = ctrl.handleToolCall('read_registers', { core: 0 });
 * Firmware is loaded at runtime via the load_firmware tool, which drives
 * the bundled bootrom end-to-end (vectored RAM-boot handshake for SRAM
 * images, normal flash scan for flash images). Or pre-seed chip state
 * via the read/write_register and read/write_memory tools.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RP2350 } from '../rp2350';
import { CPU } from '../riscv/cpu';
import { CortexM33Core } from '../cortex-m33/core';
import { formatPioDump, formatGpioDump } from './pio-gpio-dump';

/**
 * Human-readable descriptions for every tool exposed by EmulatorController.
 * Single source of truth consumed by:
 *   - src/mcp/mcp-server.ts  (MCP `description` field per tool schema)
 *   - src/rp2-emu-cli/rp2-emu.ts  (CLI per-subcommand `--help` text)
 *
 * Keep these in sync with the tool names handled in dispatch().
 */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  get_status:
    'Get emulator status. Emulation is always paused (only runs on single_step/run). emulation_running=false. wfi indicates the RISC-V wait-for-interrupt state (different from emulation pause).',
  read_registers: 'Read all registers (x0-x31, pc, CSRs) for a core',
  write_register: 'Write a single register by name (e.g. "x5", "pc", "mstatus")',
  read_memory: 'Read memory as a hex dump',
  write_memory: 'Write raw bytes to memory (hex-encoded)',
  single_step: 'Execute one instruction on the specified core',
  run: 'Run up to max_instructions, stopping at breakpoints. Returns halt reason, cycle count, and any trace hits recorded during this run.',
  set_breakpoint: 'Set a software breakpoint at an address',
  clear_breakpoint: 'Remove a breakpoint',
  list_breakpoints: 'List all active breakpoints',
  set_tracepoint:
    'Set a named tracepoint at an address. Firmware can contain hardwired trace markers (0xabcd/0xffff magic bytes followed by a NUL-terminated tag string placed at a jal return address) which fire automatically. Use list_tracepoints to see all traces including hardwired ones.',
  clear_tracepoint: 'Remove a tracepoint by label',
  list_tracepoints: 'List all tracepoints (label → address) and any recorded traces',
  dump_pio:
    'Dump PIO state machine registers (pc, x, y, ISR, OSR, FIFOs), pin routing (in_base/out_base/set_base/sideset_base/jmp_pin, with absolute chip-pin numbers, counts, wrap), and shift direction (left/right) per SM. Includes per-PIO GPIOBASE.',
  dump_gpio: 'Dump all GPIO pin states (function, in/out values, pullups)',
  load_firmware:
    'Load an Intel HEX (.hex) or UF2 (.uf2) firmware file. Re-instantiates the chip with bootrom + firmware. HEX files auto-detect SRAM vs flash from the address map; UF2 files auto-detect from the first block address. Optionally attach a .dis disassembly file for source context in run/single_step output.',
  reset:
    'Reset the chip: re-instantiate RP2350, reload bootrom + last firmware. By default clears all breakpoints and tracepoints; set keep_breakpoints to true to preserve them.',
  convert_number:
    'Convert a value between decimal and hex. Direction is auto-detected: input starting with "0x" (case-insensitive) is treated as hex and converted to decimal; otherwise the input is treated as a decimal integer and converted to hex (0x-prefixed). Both signed and unsigned 32-bit inputs are accepted.',
  dump_memory:
    'Dump a contiguous range of flash or SRAM to a temporary file. Output format: "ihex" (Intel HEX, reloadable via load_firmware) or "text" (raw hex string, one line per 16 bytes). Returns the temp file path.',
};

// CSR address map for register read/write by name
const CSR_MAP: Record<string, number> = {
  mstatus: 0x300,
  mie: 0x304,
  mtvec: 0x305,
  mepc: 0x341,
  mcause: 0x342,
  mip: 0x344,
  mhartid: 0xf14,
};

// Format a 32-bit unsigned value as a hex string, e.g. 0x12345678
function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

// Parse a flexible integer input into an unsigned 32-bit number. Accepts:
//   - JSON numbers (e.g. 305419896)
//   - decimal strings (e.g. "305419896")
//   - hex strings with 0x prefix (e.g. "0x12345678", "0XDEADBEEF")
//   - undefined/null (returns defaultValue)
// Throws on unparseable input so the caller surfaces a clear error.
function parseUint(v: unknown, defaultValue?: number): number {
  if (v === undefined || v === null) {
    if (defaultValue !== undefined) return defaultValue >>> 0;
    throw new Error('Missing required integer argument');
  }
  if (typeof v === 'number') return v >>> 0;
  if (typeof v !== 'string') {
    throw new Error(`Could not parse integer: unexpected type ${typeof v}`);
  }
  const s = v.trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) >>> 0;
  if (/^-?\d+$/.test(s)) return Number(s) >>> 0;
  throw new Error(`Could not parse integer: "${v}" (use decimal or "0x..." hex)`);
}

// Intel HEX checksum: two's complement of the LSB of the byte sum.
function ihexChecksum(byteSum: number): string {
  return ((~byteSum + 1) & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

// Encode bytes as an Intel HEX file starting at the given absolute address.
// Emits an extended linear address record for the upper 16 bits (and again
// whenever the data crosses a 64K boundary), 16-byte data records, and a
// final EOF record.
function toIntelHex(bytes: number[], startAddr: number): string {
  const lines: string[] = [];
  const emitExtendedAddr = (upper: number) => {
    const sum = 0x02 + 0x00 + 0x00 + 0x04 + (upper >> 8) + (upper & 0xff);
    lines.push(`:02000004${upper.toString(16).padStart(4, '0').toUpperCase()}${ihexChecksum(sum)}`);
  };

  let curUpper = -1;
  let offset = 0;
  while (offset < bytes.length) {
    const chunkAddr = (startAddr + offset) >>> 0;
    const upper = (chunkAddr >>> 16) & 0xffff;
    if (upper !== curUpper) {
      emitExtendedAddr(upper);
      curUpper = upper;
    }
    const lower = chunkAddr & 0xffff;
    const chunkSize = Math.min(16, bytes.length - offset);
    let sum = chunkSize + (lower >> 8) + (lower & 0xff) + 0x00; // record type 00 (data)
    let data = '';
    for (let i = 0; i < chunkSize; i++) {
      const b = bytes[offset + i];
      sum += b;
      data += b.toString(16).padStart(2, '0').toUpperCase();
    }
    lines.push(
      `:${chunkSize.toString(16).padStart(2, '0').toUpperCase()}${lower
        .toString(16)
        .padStart(4, '0')
        .toUpperCase()}00${data}${ihexChecksum(sum)}`
    );
    offset += chunkSize;
  }
  lines.push(':00000001FF'); // EOF
  return lines.join('\n') + '\n';
}

const GPR_NAMES = [
  'zero',
  'ra',
  'sp',
  'gp',
  'tp',
  't0',
  't1',
  't2',
  's0',
  's1',
  'a0',
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  's8',
  's9',
  's10',
  's11',
  't3',
  't4',
  't5',
  't6',
];

// ARM Cortex-M33 register names (r0-r15 + special registers).
// r13=sp, r14=lr, r15=pc. Aliases below map friendly names to these.
const ARM_GPR_ALIASES: Record<string, number> = {
  r0: 0,
  r1: 1,
  r2: 2,
  r3: 3,
  r4: 4,
  r5: 5,
  r6: 6,
  r7: 7,
  r8: 8,
  r9: 9,
  r10: 10,
  r11: 11,
  r12: 12,
  r13: 13,
  sp: 13,
  r14: 14,
  lr: 14,
  r15: 15,
  pc: 15,
};

// ARM special registers accessible by name (beyond r0-r15).
const ARM_SPECIAL_REGS = [
  'msp',
  'psp',
  'msp_ns',
  'psp_ns',
  'msplim',
  'psplim',
  'msplim_ns',
  'psplim_ns',
  'primask',
  'basepri',
  'faultmask',
  'control',
  'primask_ns',
  'basepri_ns',
  'faultmask_ns',
  'control_ns',
  'xpsr',
  'fpscr',
  'n',
  'z',
  'c',
  'v',
] as const;

export class EmulatorController {
  private breakpoints = new Set<number>();
  private tracepoints = new Map<string, number>(); // label → address
  private traces: { tag: string; core: number; pc: number; cycles: number }[] = [];
  // Last-loaded firmware info, for reset()
  private fwPath: string | null = null;
  private fwEntryPc: number | undefined = undefined;
  private fwUseSram: boolean = false;
  private fwIsUf2: boolean = false;
  private fwDisPath: string | null = null;
  // Disassembly: lines array + map from address to line index
  private disLines: string[] = [];
  private disMap: Map<number, number> = new Map(); // address → line index

  chip: RP2350;
  fwArch: 'riscv' | 'arm' = 'riscv';

  constructor() {
    this.chip = this.createChip();
  }

  private createChip(): RP2350 {
    // RP2350's constructor auto-loads the bundled A2 bootrom, so the chip
    // is ready to boot the same way real silicon does.
    const chip = new RP2350({ coreArch: this.fwArch });
    chip.onTrace = (core, pc, tag) => {
      this.traces.push({
        tag,
        core,
        pc: pc >>> 0,
        cycles: core === 0 ? chip.core0.cycles : chip.core1.cycles,
      });
    };
    return chip;
  }

  // Parse a .dis file into a line array and an address→line-index map.
  // Lines matching /^([0-9a-f]+):\t/ are instruction lines.
  private parseDisassembly(content: string) {
    this.disLines = content.split('\n');
    this.disMap.clear();
    for (let i = 0; i < this.disLines.length; i++) {
      const m = this.disLines[i].match(/^([0-9a-f]+):\t/);
      if (m) this.disMap.set(parseInt(m[1], 16), i);
    }
  }

  // Return ±contextLines around the disassembly entry for the given PC.
  private disasmContext(pc: number, contextLines: number = 5): string | undefined {
    const lineIdx = this.disMap.get(pc >>> 0);
    if (lineIdx === undefined) return undefined;
    const start = Math.max(0, lineIdx - contextLines);
    const end = Math.min(this.disLines.length, lineIdx + contextLines + 1);
    return this.disLines.slice(start, end).join('\n');
  }

  // Expose handler for testing without MCP transport. Wraps the dispatch in a
  // try/catch so direct callers (and the MCP transport) get a uniform
  // { isError: true, content: [...] } error shape on bad input.
  handleToolCall(name: string, args: Record<string, unknown>) {
    try {
      return this.dispatch(name, args);
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  private dispatch(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'get_status':
        return this.getStatus();
      case 'read_registers':
        return this.readRegisters(parseUint(args.core, 0));
      case 'write_register':
        return this.writeRegister(
          parseUint(args.core, 0),
          args.register as string,
          parseUint(args.value)
        );
      case 'read_memory':
        return this.readMemory(parseUint(args.address), parseUint(args.length, 32));
      case 'write_memory':
        return this.writeMemory(parseUint(args.address), args.hex as string);
      case 'single_step':
        return this.singleStep(parseUint(args.core, 0));
      case 'run':
        return this.run(parseUint(args.max_instructions, 10000));
      case 'set_breakpoint':
        return this.setBreakpoint(parseUint(args.address));
      case 'clear_breakpoint':
        return this.clearBreakpoint(parseUint(args.address));
      case 'list_breakpoints':
        return this.listBreakpoints();
      case 'set_tracepoint':
        return this.setTracepoint(args.label as string, parseUint(args.address));
      case 'clear_tracepoint':
        return this.clearTracepoint(args.label as string);
      case 'list_tracepoints':
        return this.listTracepoints();
      case 'dump_pio':
        return this.dumpPio(args.instance != null ? parseUint(args.instance) : undefined);
      case 'dump_gpio':
        return this.dumpGpio();
      case 'load_firmware':
        if (args.arch === 'arm' || args.arch === 'riscv') {
          this.fwArch = args.arch;
        }
        return this.loadFirmware(
          args.path as string,
          args.entry_pc != null ? parseUint(args.entry_pc) : undefined,
          args.use_sram as boolean | undefined,
          args.disassembly_path as string | undefined
        );
      case 'reset':
        return this.reset(args.keep_breakpoints as boolean | undefined);
      case 'convert_number':
        return this.convertNumber(args.value as string | number);
      case 'dump_memory':
        return this.dumpMemory(
          args.region as 'flash' | 'sram',
          parseUint(args.address),
          parseUint(args.length),
          (args.format as 'ihex' | 'text') ?? 'ihex'
        );
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  }

  private cpu(core: number): CPU {
    return this.chip.core[core] as CPU;
  }

  private armCore(core: number): CortexM33Core {
    return this.chip.core[core] as CortexM33Core;
  }

  private json(data: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  private text(data: string) {
    return { content: [{ type: 'text', text: data }] };
  }

  private getStatus() {
    return this.json({
      emulation_running: false,
      arch: this.chip.coreArch,
      core0: { pc: hex(this.chip.core[0].PC), wfi: this.chip.core[0].waiting },
      core1: { pc: hex(this.chip.core[1].PC), wfi: this.chip.core[1].waiting },
      breakpoints: [...this.breakpoints].map((a) => hex(a)),
      tracepoints: [...this.tracepoints.entries()].map(([label, addr]) => ({
        label,
        address: hex(addr),
      })),
      disassembly_loaded: this.disLines.length > 0,
      disassembly_path: this.fwDisPath,
    });
  }

  private readRegisters(core: number) {
    if (this.chip.coreArch === 'arm') return this.readArmRegisters(core);
    const cpu = this.cpu(core);
    const regs: Record<string, string> = {};
    for (let i = 0; i < 32; i++) {
      regs[GPR_NAMES[i]] = hex(cpu.getRegisterU(i));
    }
    regs.pc = hex(cpu.pc);
    for (const [csrName, csrAddr] of Object.entries(CSR_MAP)) {
      regs[csrName] = hex(cpu.getCSR(csrAddr, 0));
    }
    return this.json(regs);
  }

  private readArmRegisters(core: number) {
    const r = this.armCore(core).regs;
    const regs: Record<string, string> = {};
    for (let i = 0; i < 16; i++) regs[`r${i}`] = hex(r.r[i]);
    regs.sp = hex(r.sp);
    regs.lr = hex(r.r[14]);
    regs.pc = hex(r.pc);
    for (const name of ARM_SPECIAL_REGS) {
      // Flags are boolean; report as 0/1.
      if (name === 'n') regs.n = r.N ? '1' : '0';
      else if (name === 'z') regs.z = r.Z ? '1' : '0';
      else if (name === 'c') regs.c = r.C ? '1' : '0';
      else if (name === 'v') regs.v = r.V ? '1' : '0';
      else regs[name] = hex((r as unknown as Record<string, number>)[name]);
    }
    return this.json(regs);
  }

  private writeRegister(core: number, register: string, value: number) {
    if (this.chip.coreArch === 'arm') return this.writeArmRegister(core, register, value);
    const cpu = this.cpu(core);
    const v = value >>> 0;

    if (register === 'pc') {
      cpu.pc = v;
      return this.json({ ok: true });
    }
    const gprIdx = GPR_NAMES.indexOf(register);
    if (gprIdx >= 0 || /^x\d+$/i.test(register)) {
      const idx = gprIdx >= 0 ? gprIdx : parseInt(register.substring(1));
      cpu.setRegisterU(idx, v);
      return this.json({ ok: true });
    }
    if (register in CSR_MAP) {
      cpu.setCSR(CSR_MAP[register], v, 0);
      return this.json({ ok: true });
    }
    return { content: [{ type: 'text', text: `Unknown register: ${register}` }], isError: true };
  }

  private writeArmRegister(core: number, register: string, value: number) {
    const r = this.armCore(core).regs;
    const v = value >>> 0;
    const name = register.toLowerCase();

    // GPRs and aliases (r0-r15, sp, lr, pc).
    if (name in ARM_GPR_ALIASES) {
      const idx = ARM_GPR_ALIASES[name];
      r.r[idx] = v;
      return this.json({ ok: true });
    }
    // Special registers (msp, psp, primask, control, xpsr, fpscr, ...).
    if (ARM_SPECIAL_REGS.includes(name as (typeof ARM_SPECIAL_REGS)[number])) {
      const store = r as unknown as Record<string, number>;
      if (name === 'n') r.N = v !== 0;
      else if (name === 'z') r.Z = v !== 0;
      else if (name === 'c') r.C = v !== 0;
      else if (name === 'v') r.V = v !== 0;
      else store[name] = v;
      return this.json({ ok: true });
    }
    return { content: [{ type: 'text', text: `Unknown register: ${register}` }], isError: true };
  }

  private readMemory(address: number, length: number) {
    const bytes: number[] = [];
    for (let i = 0; i < length; i++) {
      let b: number;
      try {
        b = this.chip.readUint8(address + i);
      } catch {
        b = 0xff;
      }
      bytes.push(b);
    }
    // Format as a hex dump with address offsets
    let dump = '';
    for (let i = 0; i < length; i += 16) {
      const addr = (address + i) >>> 0;
      const slice = bytes.slice(i, i + 16);
      const hexPart = slice
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47, ' ');
      const asciiPart = slice
        .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.'))
        .join('');
      dump += `0x${addr.toString(16).padStart(8, '0')}  ${hexPart}  ${asciiPart}\n`;
    }
    return this.text(dump.trimEnd());
  }

  private writeMemory(address: number, hex: string) {
    const data = Buffer.from(hex, 'hex');
    for (let i = 0; i < data.length; i++) {
      this.chip.writeUint8(address + i, data[i]);
    }
    return this.json({ ok: true, bytes_written: data.length });
  }

  private formatTrace(t: { tag: string; core: number; pc: number; cycles: number }) {
    return { tag: t.tag, core: t.core, pc: hex(t.pc), cycles: t.cycles };
  }

  private singleStep(core: number) {
    const cpu = this.chip.core[core];
    this.chip.currentCore = core;
    const traceStart = this.traces.length;
    const elapsed = cpu.executeInstruction();
    if (core === 0) this.chip.stepThings(elapsed);
    const pc = cpu.PC >>> 0;
    const result: Record<string, unknown> = {
      core,
      pc: hex(pc),
      traces: this.traces.slice(traceStart).map((t) => this.formatTrace(t)),
    };
    const ctx = this.disasmContext(pc);
    if (ctx) result.disassembly = ctx;
    return this.json(result);
  }

  private run(maxInstructions: number) {
    this.chip.core1.waiting = true; // park core1 by default
    const traceStart = this.traces.length;
    const hitBp = (core: number): boolean => {
      const cpu = this.chip.core[core];
      return !cpu.waiting && this.breakpoints.has(cpu.PC >>> 0);
    };
    let instructions = 0;
    const result = (halted: boolean, reason: string, core?: number) => {
      const r: Record<string, unknown> = {
        halted,
        reason,
        core,
        core0_pc: hex(this.chip.core0.PC),
        core1_pc: hex(this.chip.core1.PC),
        instructions_executed: instructions,
        cycles: this.chip.core0.cycles,
        traces: this.traces.slice(traceStart).map((t) => this.formatTrace(t)),
      };
      // Show disassembly context for the halted core
      const haltPc = this.chip.core[core ?? 0].PC >>> 0;
      const ctx = this.disasmContext(haltPc);
      if (ctx) r.disassembly = ctx;
      return this.json(r);
    };

    while (instructions < maxInstructions) {
      // If both cores are parked, nothing will happen — bail out
      if (this.chip.core0.waiting && this.chip.core1.waiting) {
        return result(false, 'idle');
      }

      // Step whichever core has fewer cycles. Only core0 advances wall-clock
      // time for peripherals; core1 is catching up.
      this.chip.currentCore =
        this.chip.core[0].getCycles() <= this.chip.core[1].getCycles() ? 0 : 1;
      const cpu = this.chip.core[this.chip.currentCore];
      const wasWaiting = cpu.waiting;
      const elapsed = cpu.executeInstruction();
      if (this.chip.currentCore === 0) this.chip.stepThings(elapsed);

      // Only count non-WFI instructions toward the limit
      if (!wasWaiting) instructions++;

      // Check breakpoints on the core that just ran
      if (hitBp(this.chip.currentCore)) {
        return result(true, 'breakpoint', this.chip.currentCore);
      }
    }
    return result(false, 'max_reached');
  }

  private setBreakpoint(address: number) {
    this.breakpoints.add(address >>> 0);
    return this.json({ ok: true, address: hex(address) });
  }

  private clearBreakpoint(address: number) {
    this.breakpoints.delete(address >>> 0);
    return this.json({ ok: true, address: hex(address) });
  }

  private listBreakpoints() {
    return this.json({ addresses: [...this.breakpoints].map((a) => hex(a)) });
  }

  private setTracepoint(label: string, address: number) {
    this.tracepoints.set(label, address >>> 0);
    return this.json({ ok: true, label, address: hex(address) });
  }

  private clearTracepoint(label: string) {
    const existed = this.tracepoints.delete(label);
    return this.json({ ok: true, label, existed });
  }

  private listTracepoints() {
    const tps = [...this.tracepoints.entries()].map(([label, address]) => ({
      label,
      address: hex(address),
    }));
    return this.json({ tracepoints: tps });
  }

  private loadFirmware(
    path: string,
    entryPc?: number,
    useSram?: boolean,
    disassemblyPath?: string
  ) {
    // Drive the bootrom the same way nsboot does on real hardware: for SRAM
    // images we set up the watchdog scratch vectored-boot handshake; the
    // bootrom then scans the window and extracts the real entry PC + SP
    // from the IMAGE_DEF. For flash images we let the bootrom do its normal
    // flash scan. If `entryPc` is supplied, the helper bypasses the bootrom
    // and sets both cores' PC directly (used for synthetic fixtures without
    // an IMAGE_DEF, or to force a specific entry).
    this.fwPath = path;
    this.chip = this.createChip();
    const result = this.chip.loadFirmware(path, { entryPc });
    this.fwUseSram = result.useSram;
    this.fwIsUf2 = result.format === 'uf2';
    this.fwEntryPc = entryPc != null ? entryPc >>> 0 : undefined;

    // Load disassembly if provided (or auto-detect .dis alongside .hex/.uf2)
    const disPath = disassemblyPath ?? path.replace(/\.(hex|uf2)$/i, '.dis');
    if (fs.existsSync(disPath)) {
      this.fwDisPath = disPath;
      this.parseDisassembly(fs.readFileSync(disPath, 'utf-8'));
    } else {
      this.fwDisPath = null;
      this.disLines = [];
      this.disMap.clear();
    }

    this.breakpoints.clear();
    this.tracepoints.clear();
    this.traces = [];
    return this.json({
      ok: true,
      path,
      entry_pc: this.fwEntryPc != null ? hex(this.fwEntryPc) : null,
      use_sram: this.fwUseSram,
      format: this.fwIsUf2 ? 'uf2' : 'hex',
      disassembly_loaded: this.disLines.length > 0,
    });
  }

  // Dump a range of flash or SRAM to a temp file. Region selects the base
  // address (flash=0x10000000, sram=0x20000000); address is an offset within
  // that region. Output is Intel HEX (default) or plain hex text.
  private dumpMemory(
    region: 'flash' | 'sram',
    address: number,
    length: number,
    format: 'ihex' | 'text'
  ) {
    if (length <= 0) {
      return {
        content: [{ type: 'text', text: `length must be > 0 (got ${length})` }],
        isError: true,
      };
    }
    const baseAddr = region === 'sram' ? 0x20000000 : 0x10000000;
    const absAddr = (baseAddr + address) >>> 0;

    // Read bytes; treat unmapped reads as 0xff (matches readMemory behaviour)
    const bytes: number[] = [];
    for (let i = 0; i < length; i++) {
      let b: number;
      try {
        b = this.chip.readUint8(absAddr + i);
      } catch {
        b = 0xff;
      }
      bytes.push(b);
    }

    let content: string;
    let ext: string;
    if (format === 'ihex') {
      content = toIntelHex(bytes, absAddr);
      ext = '.hex';
    } else {
      // One 16-byte row per line, address-prefixed for readability
      const lines: string[] = [];
      for (let i = 0; i < bytes.length; i += 16) {
        const slice = bytes.slice(i, i + 16);
        const addr = (absAddr + i) >>> 0;
        const hexPart = slice.map((b) => b.toString(16).padStart(2, '0')).join('');
        lines.push(`${hex(addr)} ${hexPart}`);
      }
      content = lines.join('\n') + '\n';
      ext = '.txt';
    }

    // Use randomBytes for an atomic, collision-free temp filename (Date.now()
    // alone collides under parallel dump_memory calls within the same ms).
    const rand = randomBytes(8).toString('hex');
    const tmpPath = path.join(os.tmpdir(), `rp2350-dump-${region}-${hex(absAddr)}-${rand}${ext}`);
    fs.writeFileSync(tmpPath, content);

    return this.json({
      ok: true,
      path: tmpPath,
      region,
      address: hex(absAddr),
      length,
      format,
      file_size: content.length,
    });
  }

  // Convert a value between decimal and hex. Direction is auto-detected:
  // inputs prefixed with "0x" (case-insensitive) are hex→dec, all others are
  // dec→hex. Accepts the value as either a string or a JSON number.
  private convertNumber(value: string | number) {
    const str = typeof value === 'number' ? String(value) : value.trim();
    const isHex = /^0x[0-9a-f]+$/i.test(str);
    const isDec = /^-?\d+$/.test(str);

    if (isHex) {
      const n = parseInt(str, 16) >>> 0;
      return this.json({ input: str, hex: hex(n), decimal: n });
    }
    if (isDec) {
      // >>> 0 normalizes negative numbers to their unsigned 32-bit representation
      const n = Number(str) >>> 0;
      return this.json({ input: str, hex: hex(n), decimal: n });
    }
    return {
      content: [
        {
          type: 'text',
          text: `Could not parse "${str}". Use "0x..." for hex or a decimal integer.`,
        },
      ],
      isError: true,
    };
  }

  private reset(keepBreakpoints = false) {
    if (this.fwPath) {
      // Re-load firmware through the bootrom-based path. Pass any explicit
      // entryPc override preserved from the original load_firmware call.
      this.chip = this.createChip();
      this.chip.loadFirmware(this.fwPath, {
        entryPc: this.fwEntryPc,
      });
      // Reload disassembly if it was previously loaded
      if (this.fwDisPath && fs.existsSync(this.fwDisPath)) {
        this.parseDisassembly(fs.readFileSync(this.fwDisPath, 'utf-8'));
      }
    } else {
      this.chip = this.createChip();
      this.fwDisPath = null;
      this.disLines = [];
      this.disMap.clear();
    }
    if (!keepBreakpoints) {
      this.breakpoints.clear();
      this.tracepoints.clear();
    }
    this.traces = [];
    return this.json({
      ok: true,
      firmware_loaded: this.fwPath !== null,
      disassembly_loaded: this.disLines.length > 0,
      breakpoints_kept: keepBreakpoints,
    });
  }

  private dumpPio(instance?: number) {
    return this.text(formatPioDump(this.chip, instance) + '\n');
  }

  private dumpGpio() {
    return this.text(formatGpioDump(this.chip) + '\n');
  }
}
