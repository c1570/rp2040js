/**
 * ARM (Cortex-M0) GDB Server for RP2040 dual-core.
 *
 * Copyright (C) 2021, Uri Shaked
 * Modified by github.com/c1570 for dual-core
 *
 * Exposes both ARM cores as GDB threads (thread 1 = core0, thread 2 = core1).
 * Software breakpoints via PC checking + BKPT instruction traps.
 */

import { SYSM_CONTROL, SYSM_MSP, SYSM_PRIMASK, SYSM_PSP } from '../cortex-m0-core';
import { CortexM0Core } from '../cortex-m0-core';
import { RP2040 } from '../rp2040';
import { GDBServer } from './gdb-server';
import { IGDBTarget } from './gdb-target';
import { GDBConnection } from './gdb-connection';
import {
  decodeHexBuf,
  encodeHexBuf,
  encodeHexByte,
  encodeHexUint32,
  gdbMessage,
  unescapeBinary,
} from './gdb-utils';
import { formatPioDump, formatGpioDump } from '../utils/pio-gpio-dump';

/* string value: armv6m-none-unknown-eabi */
const lldbTriple = '61726d76366d2d6e6f6e652d756e6b6e6f776e2d65616269';

const registers = [
  `name:r0;bitsize:32;offset:0;encoding:int;format:hex;set:General Purpose Registers;generic:arg1;gcc:0;dwarf:0;`,
  `name:r1;bitsize:32;offset:4;encoding:int;format:hex;set:General Purpose Registers;generic:arg2;gcc:1;dwarf:1;`,
  `name:r2;bitsize:32;offset:8;encoding:int;format:hex;set:General Purpose Registers;generic:arg3;gcc:2;dwarf:2;`,
  `name:r3;bitsize:32;offset:12;encoding:int;format:hex;set:General Purpose Registers;generic:arg4;gcc:3;dwarf:3;`,
  `name:r4;bitsize:32;offset:16;encoding:int;format:hex;set:General Purpose Registers;gcc:4;dwarf:4;`,
  `name:r5;bitsize:32;offset:20;encoding:int;format:hex;set:General Purpose Registers;gcc:5;dwarf:5;`,
  `name:r6;bitsize:32;offset:24;encoding:int;format:hex;set:General Purpose Registers;gcc:6;dwarf:6;`,
  `name:r7;bitsize:32;offset:28;encoding:int;format:hex;set:General Purpose Registers;gcc:7;dwarf:7;`,
  `name:r8;bitsize:32;offset:32;encoding:int;format:hex;set:General Purpose Registers;gcc:8;dwarf:8;`,
  `name:r9;bitsize:32;offset:36;encoding:int;format:hex;set:General Purpose Registers;gcc:9;dwarf:9;`,
  `name:r10;bitsize:32;offset:40;encoding:int;format:hex;set:General Purpose Registers;gcc:10;dwarf:10;`,
  `name:r11;bitsize:32;offset:44;encoding:int;format:hex;set:General Purpose Registers;generic:fp;gcc:11;dwarf:11;`,
  `name:r12;bitsize:32;offset:48;encoding:int;format:hex;set:General Purpose Registers;gcc:12;dwarf:12;`,
  `name:sp;bitsize:32;offset:52;encoding:int;format:hex;set:General Purpose Registers;generic:sp;alt-name:r13;gcc:13;dwarf:13;`,
  `name:lr;bitsize:32;offset:56;encoding:int;format:hex;set:General Purpose Registers;generic:ra;alt-name:r14;gcc:14;dwarf:14;`,
  `name:pc;bitsize:32;offset:60;encoding:int;format:hex;set:General Purpose Registers;generic:pc;alt-name:r15;gcc:15;dwarf:15;`,
  `name:cpsr;bitsize:32;offset:64;encoding:int;format:hex;set:General Purpose Registers;generic:flags;alt-name:psr;gcc:16;dwarf:16;`,
];

const targetXML = `<?xml version="1.0"?>
<!DOCTYPE target SYSTEM "gdb-target.dtd">
<target version="1.0">
<architecture>arm</architecture>
<feature name="org.gnu.gdb.arm.m-profile">
<reg name="r0" bitsize="32" regnum="0" save-restore="yes" type="int" group="general"/>
<reg name="r1" bitsize="32" regnum="1" save-restore="yes" type="int" group="general"/>
<reg name="r2" bitsize="32" regnum="2" save-restore="yes" type="int" group="general"/>
<reg name="r3" bitsize="32" regnum="3" save-restore="yes" type="int" group="general"/>
<reg name="r4" bitsize="32" regnum="4" save-restore="yes" type="int" group="general"/>
<reg name="r5" bitsize="32" regnum="5" save-restore="yes" type="int" group="general"/>
<reg name="r6" bitsize="32" regnum="6" save-restore="yes" type="int" group="general"/>
<reg name="r7" bitsize="32" regnum="7" save-restore="yes" type="int" group="general"/>
<reg name="r8" bitsize="32" regnum="8" save-restore="yes" type="int" group="general"/>
<reg name="r9" bitsize="32" regnum="9" save-restore="yes" type="int" group="general"/>
<reg name="r10" bitsize="32" regnum="10" save-restore="yes" type="int" group="general"/>
<reg name="r11" bitsize="32" regnum="11" save-restore="yes" type="int" group="general"/>
<reg name="r12" bitsize="32" regnum="12" save-restore="yes" type="int" group="general"/>
<reg name="sp" bitsize="32" regnum="13" save-restore="yes" type="data_ptr" group="general"/>
<reg name="lr" bitsize="32" regnum="14" save-restore="yes" type="int" group="general"/>
<reg name="pc" bitsize="32" regnum="15" save-restore="yes" type="code_ptr" group="general"/>
<reg name="xPSR" bitsize="32" regnum="16" save-restore="yes" type="int" group="general"/>
</feature>
<feature name="org.gnu.gdb.arm.m-system">
<reg name="msp" bitsize="32" regnum="17" save-restore="yes" type="data_ptr" group="system"/>
<reg name="psp" bitsize="32" regnum="18" save-restore="yes" type="data_ptr" group="system"/>
<reg name="primask" bitsize="1" regnum="19" save-restore="yes" type="int8" group="system"/>
<reg name="basepri" bitsize="8" regnum="20" save-restore="yes" type="int8" group="system"/>
<reg name="faultmask" bitsize="1" regnum="21" save-restore="yes" type="int8" group="system"/>
<reg name="control" bitsize="2" regnum="22" save-restore="yes" type="int8" group="system"/>
</feature>
</target>`;

export class ArmGDBServer extends GDBServer {
  constructor(readonly target: IGDBTarget<RP2040>) {
    super(target.rpchip, () => target.stop());
  }

  private get rpchip() {
    return this.target.rpchip;
  }

  private get core(): CortexM0Core {
    return this.rpchip.core[this.currentThread - 1];
  }

  protected readRegister(index: number): number {
    const core = this.core;
    if (index >= 0 && index <= 15) return core.registers[index];
    switch (index) {
      case 0x10:
        return core.xPSR;
      case 0x11:
        return core.readSpecialRegister(SYSM_MSP);
      case 0x12:
        return core.readSpecialRegister(SYSM_PSP);
      case 0x13:
        return core.readSpecialRegister(SYSM_PRIMASK);
      case 0x14:
        return 0; // BASEPRI not implemented on Cortex-M0
      case 0x15:
        return 0; // faultmask not implemented on Cortex-M0
      case 0x16:
        return core.readSpecialRegister(SYSM_CONTROL);
    }
    return 0;
  }

  protected writeRegister(index: number, value: number) {
    const core = this.core;
    if (index >= 0 && index <= 15) {
      core.registers[index] = value;
      return;
    }
    switch (index) {
      case 0x10:
        core.xPSR = value;
        break;
      case 0x11:
        core.writeSpecialRegister(SYSM_MSP, value);
        break;
      case 0x12:
        core.writeSpecialRegister(SYSM_PSP, value);
        break;
      case 0x13:
        core.writeSpecialRegister(SYSM_PRIMASK, value);
        break;
      case 0x16:
        core.writeSpecialRegister(SYSM_CONTROL, value);
        break;
    }
  }

  processGDBMessage(cmd: string): string | void {
    const { rpchip } = this;

    switch (cmd[0]) {
      case '?':
        return gdbMessage(`T05thread:${this.haltedCore + 1};`);

      case 'T': {
        // Thread alive query: T<thread-id>
        const tid = parseInt(cmd.substring(1));
        if (tid === 1 || tid === 2) return gdbMessage('OK');
        return gdbMessage('E01');
      }

      case 'H': {
        const threadId = parseInt(cmd.substring(2));
        if (threadId === 0 || threadId === -1 || threadId === 1 || threadId === 2) {
          if (threadId >= 1) this.currentThread = threadId;
          return gdbMessage('OK');
        }
        return gdbMessage('E01');
      }

      case 'q':
        if (cmd.startsWith('qSupported:')) {
          return gdbMessage('PacketSize=4000;vContSupported+;qXfer:features:read+');
        }
        if (cmd === 'qAttached') {
          return gdbMessage('1');
        }
        if (cmd.startsWith('qXfer:features:read:target.xml')) {
          return gdbMessage('l' + targetXML);
        }
        if (cmd.startsWith('qRegisterInfo')) {
          const index = parseInt(cmd.substring(13), 16);
          const register = registers[index];
          if (register) return gdbMessage(register);
          return gdbMessage('E45');
        }
        if (cmd === 'qHostInfo') {
          return gdbMessage(`triple:${lldbTriple};endian:little;ptrsize:4;`);
        }
        if (cmd === 'qProcessInfo') {
          return gdbMessage('pid:1;endian:little;ptrsize:4;');
        }
        if (cmd === 'qfThreadInfo') return gdbMessage('m1,2');
        if (cmd === 'qsThreadInfo') return gdbMessage('l');
        if (cmd === 'qC') return gdbMessage('QC1');
        if (cmd.startsWith('qThreadStopInfo')) {
          const tid = parseInt(cmd.substring(15));
          return gdbMessage(`T05thread:${tid};`);
        }
        if (cmd.startsWith('qRcmd,')) {
          return this.handleMonitor(cmd.substring(6));
        }
        return gdbMessage('');

      case 'v':
        if (cmd === 'vCont?') {
          return gdbMessage('vCont;c;C;s;S');
        }
        if (cmd.startsWith('vCont;')) {
          const actions = cmd.substring(6).split(';');
          // Collect continue and step actions. GDB may send multiple actions
          // (e.g. vCont;c:1;c:2) to resume different threads.
          let continueTids: number[] = [];
          let stepTid = 0;
          for (const action of actions) {
            const colonIdx = action.indexOf(':');
            const tid = colonIdx >= 0 ? parseInt(action.substring(colonIdx + 1)) : 0;
            if (action[0] === 'c') {
              continueTids.push(tid);
            } else if (action[0] === 's') {
              stepTid = tid >= 1 ? tid : this.currentThread;
            }
          }

          // Step takes priority (returns a synchronous stop reply)
          if (stepTid > 0) {
            const stepCore = rpchip.core[stepTid - 1];
            rpchip.currentCore = stepTid - 1;
            stepCore.executeInstruction();
            this.haltedCore = stepTid - 1;
            const regStatus = [];
            for (let i = 0; i < 17; i++) {
              const val = i === 16 ? stepCore.xPSR : stepCore.registers[i];
              regStatus.push(`${encodeHexByte(i)}:${encodeHexUint32(val)}`);
            }
            return gdbMessage(`T05${regStatus.join(';')};thread:${stepTid};reason:trace;`);
          }

          // Determine which cores to continue
          if (continueTids.length > 0) {
            const allThreads = continueTids.some((t) => t === 0);
            const hasCore0 = allThreads || continueTids.includes(1);
            const hasCore1 = allThreads || continueTids.includes(2);
            if (hasCore0 && hasCore1) {
              // If one core is in WFI, step only the other
              if (rpchip.core[0].waiting && !rpchip.core[1].waiting) this.singleCore = 1;
              else if (rpchip.core[1].waiting && !rpchip.core[0].waiting) this.singleCore = 0;
              else this.singleCore = -1;
            } else if (hasCore0) {
              this.currentThread = 1;
              if (rpchip.core[0].waiting) {
                this.haltedCore = 0;
                setTimeout(() => this.notifyBreakpoint(1), 0);
                return;
              }
              this.singleCore = 0;
            } else {
              this.currentThread = 2;
              if (rpchip.core[1].waiting) {
                this.haltedCore = 1;
                setTimeout(() => this.notifyBreakpoint(2), 0);
                return;
              }
              this.singleCore = 1;
            }
            if (!this.executing) this.execute();
            return;
          }
          return gdbMessage('');
        }
        if (cmd.startsWith('vKill')) {
          this.stop();
          return gdbMessage('OK');
        }
        return gdbMessage('');

      case 'c':
        if (!this.executing) this.execute();
        return gdbMessage('OK');

      case 'g': {
        const buf = new Uint32Array(17);
        const core = this.core;
        buf.set(core.registers);
        buf[16] = core.xPSR;
        return gdbMessage(encodeHexBuf(new Uint8Array(buf.buffer)));
      }

      case 'p': {
        const index = parseInt(cmd.substring(1), 16);
        const val = this.readRegister(index);
        // For 1-bit registers (primask, faultmask) and 8-bit (basepri),
        // GDB expects the raw byte count, but we always return 4 bytes for simplicity
        return gdbMessage(encodeHexUint32(val));
      }

      case 'P': {
        const params = cmd.substring(1).split('=');
        const index = parseInt(params[0], 16);
        const registerValue = params[1].trim();
        const decodedValue = decodeHexBuf(registerValue);
        const valueBuffer = new Uint8Array(4);
        valueBuffer.set(decodedValue.slice(0, 4));
        const value = new DataView(valueBuffer.buffer).getUint32(0, true);
        this.writeRegister(index, value);
        return gdbMessage('OK');
      }

      case 'm': {
        const params = cmd.substring(1).split(',');
        const address = parseInt(params[0], 16);
        const length = parseInt(params[1], 16);
        let result = '';
        for (let i = 0; i < length; i++) {
          try {
            result += encodeHexByte(rpchip.readUint8(address + i));
          } catch {
            result += 'ff';
          }
        }
        return gdbMessage(result);
      }

      case 'M': {
        const params = cmd.substring(1).split(/[,:]/);
        const address = parseInt(params[0], 16);
        const length = parseInt(params[1], 16);
        const data = decodeHexBuf(params[2].substring(0, length * 2));
        for (let i = 0; i < data.length; i++) {
          rpchip.writeUint8(address + i, data[i]);
        }
        return gdbMessage('OK');
      }

      case 'X': {
        // Binary memory write: X<addr>,<length>:<escaped-binary>
        const colonIdx = cmd.indexOf(':');
        const header = cmd.substring(1, colonIdx).split(',');
        const address = parseInt(header[0], 16);
        const data = unescapeBinary(cmd.substring(colonIdx + 1));
        for (let i = 0; i < data.length; i++) {
          rpchip.writeUint8(address + i, data[i]);
        }
        return gdbMessage('OK');
      }

      case 'Z': {
        // Set breakpoint: Z0/Z1,addr,kind
        const params = cmd.substring(1).split(',');
        const type = params[0];
        const address = parseInt(params[1], 16);
        if (type === '0' || type === '1') {
          this.breakpoints.add(address);
          return gdbMessage('OK');
        }
        return gdbMessage('');
      }

      case 'z': {
        // Clear breakpoint: z0/z1,addr,kind
        const params = cmd.substring(1).split(',');
        const type = params[0];
        const address = parseInt(params[1], 16);
        if (type === '0' || type === '1') {
          this.breakpoints.delete(address);
          return gdbMessage('OK');
        }
        return gdbMessage('');
      }

      case 'D':
        this.stop();
        return gdbMessage('OK');
    }

    this.warn(`Unhandled GDB packet: ${cmd}`);
    return gdbMessage('');
  }

  addConnection(connection: GDBConnection) {
    super.addConnection(connection);
    // BKPT instruction traps: both cores can trigger
    const setupBreak = (core: CortexM0Core, coreId: number) => {
      core.onBreak = () => {
        this.stopped = true;
        this.executing = false;
        this.stopTarget?.();
        core.PC -= core.breakRewind;
        this.haltedCore = coreId;
        this.notifyBreakpoint(coreId + 1);
      };
    };
    setupBreak(this.rpchip.core[0], 0);
    setupBreak(this.rpchip.core[1], 1);
  }

  private handleMonitor(hexCmd: string): string {
    const cmd = Buffer.from(decodeHexBuf(hexCmd)).toString('ascii').trim();
    const parts = cmd.split(/\s+/);
    const sub = parts[0];

    const monitorReply = (msg: string) =>
      gdbMessage('O' + encodeHexBuf(new TextEncoder().encode(msg))) + gdbMessage('OK');

    if (sub === 'pio') {
      return this.dumpPio(parts[1] ? parseInt(parts[1]) : -1);
    }
    if (sub === 'gpio') {
      return this.dumpGpio();
    }
    if (sub === 'help' || sub === '') {
      return monitorReply(
        'Available monitor commands:\n  pio [n]  - dump PIO state (all or instance n)\n  gpio     - dump GPIO pin state'
      );
    }
    return monitorReply(
      `Unknown monitor command: ${cmd}\nType "monitor help" for available commands`
    );
  }

  private dumpPio(instance: number): string {
    const body = formatPioDump(this.rpchip, instance >= 0 ? instance : undefined) + '\n';
    return gdbMessage('O' + encodeHexBuf(new TextEncoder().encode(body))) + gdbMessage('OK');
  }

  private dumpGpio(): string {
    const body = formatGpioDump(this.rpchip) + '\n';
    return gdbMessage('O' + encodeHexBuf(new TextEncoder().encode(body))) + gdbMessage('OK');
  }
}
