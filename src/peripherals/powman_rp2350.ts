import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';
import { Float64 } from '../utils/types';

const BADPASSWD = 0x00;
const SET_TIME_63TO48 = 0x60;
const SET_TIME_47TO32 = 0x64;
const SET_TIME_31TO16 = 0x68;
const SET_TIME_15TO0 = 0x6c;
const READ_TIME_UPPER = 0x70;
const READ_TIME_LOWER = 0x74;
const TIMER = 0x88;

const PASSWORD = 0x5afe;

const TIMER_RUN = 1 << 1;
const TIMER_CLEAR = 1 << 2;
const TIMER_USING_LPOSC = 1 << 17;

const TWO32 = 0x100000000;
const REG_WORDS = 0x100 >> 2;

/**
 * RP2350 POWMAN (Power Management) peripheral.
 * Models the AON millisecond timer and write-password gate.
 * See RP2350 datasheet §6.4
 */
export class RP2350POWMAN<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private baseMs = 0;
  private runStartNanos: Float64 = 0;
  private running = false;
  private badPasswd = false;
  private readonly setWords = new Uint16Array(4);
  private readonly regs = new Uint32Array(REG_WORDS);

  private nowMs(): number {
    if (!this.running) return this.baseMs;
    return this.baseMs + (this.rp2040.clock.getNanos() - this.runStartNanos) / 1e6;
  }

  readUint32(offset: number) {
    switch (offset) {
      case BADPASSWD:
        return this.badPasswd ? 1 : 0;
      case READ_TIME_LOWER:
        return Math.floor(this.nowMs()) % TWO32 >>> 0;
      case READ_TIME_UPPER:
        return Math.floor(Math.floor(this.nowMs()) / TWO32) >>> 0;
      case TIMER:
        return (this.regs[TIMER >> 2] | (this.running ? TIMER_RUN | TIMER_USING_LPOSC : 0)) >>> 0;
    }
    if (offset < 0x100) return this.regs[offset >> 2];
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (((value >>> 16) & 0xffff) !== PASSWORD) {
      this.badPasswd = true;
      return;
    }
    const data = value & 0xffff;
    switch (offset) {
      case BADPASSWD:
        this.badPasswd = false;
        return;
      case SET_TIME_15TO0:
        this.applySet(0, data);
        return;
      case SET_TIME_31TO16:
        this.applySet(1, data);
        return;
      case SET_TIME_47TO32:
        this.applySet(2, data);
        return;
      case SET_TIME_63TO48:
        this.applySet(3, data);
        return;
      case TIMER:
        if (data & TIMER_CLEAR) {
          this.baseMs = 0;
          this.setWords.fill(0);
          this.runStartNanos = this.rp2040.clock.getNanos();
        }
        if (data & TIMER_RUN) {
          if (!this.running) {
            this.baseMs = this.nowMs();
            this.runStartNanos = this.rp2040.clock.getNanos();
            this.running = true;
          }
        } else if (this.running) {
          this.baseMs = this.nowMs();
          this.running = false;
        }
        this.regs[TIMER >> 2] = data & ~(TIMER_RUN | TIMER_CLEAR);
        return;
    }
    if (offset < 0x100) this.regs[offset >> 2] = data;
  }

  private applySet(index: number, data: number) {
    this.setWords[index] = data & 0xffff;
    const lo = (this.setWords[0] | (this.setWords[1] << 16)) >>> 0;
    const hi = (this.setWords[2] | (this.setWords[3] << 16)) >>> 0;
    this.baseMs = hi * TWO32 + lo;
    if (this.running) this.runStartNanos = this.rp2040.clock.getNanos();
  }
}
