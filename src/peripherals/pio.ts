import { IRPChip } from '../rpchip';
import { FIFO } from '../utils/fifo';
import { BasePeripheral, Peripheral } from './peripheral';

// Generic registers
const CTRL = 0x000;
const FSTAT = 0x004;
const FDEBUG = 0x008;
const FLEVEL = 0x00c;
const IRQ_REG = 0x030;
const IRQ_FORCE = 0x034;
const INPUT_SYNC_BYPASS = 0x038;
const DBG_PADOUT = 0x03c;
const DBG_PADOE = 0x040;
const DBG_CFGINFO = 0x044;
const INSTR_MEM0 = 0x48;
const INSTR_MEM31 = 0x0c4;

const INTR = 0x128; // Raw Interrupts
const RP2350_INTR = 0x16c;
const IRQ0_INTE = 0x12c; // Interrupt Enable for irq0
const IRQ0_INTF = 0x130; // Interrupt Force for irq0
const IRQ0_INTS = 0x134; // Interrupt status after masking & forcing for irq0
const IRQ1_INTE = 0x138; // Interrupt Enable for irq1
const IRQ1_INTF = 0x13c; // Interrupt Force for irq1
const IRQ1_INTS = 0x140; // Interrupt status after masking & forcing for irq1

const RP2350_GPIOBASE = 0x168;

// State-machine specific registers
const TXF0 = 0x010;
const TXF1 = 0x014;
const TXF2 = 0x018;
const TXF3 = 0x01c;
const RXF0 = 0x020;
const RXF1 = 0x024;
const RXF2 = 0x028;
const RXF3 = 0x02c;
const SM0_CLKDIV = 0x0c8; // Clock divisor register for state machine 0
const SM0_EXECCTRL = 0x0cc; // Execution/behavioural settings for state machine 0
const SM0_SHIFTCTRL = 0x0d0; // Control behaviour of the input/output shift registers for state machine 0
const SM0_ADDR = 0x0d4; // Current instruction address of state machine 0
const SM0_INSTR = 0x0d8; // Write to execute an instruction immediately (including jumps) and then resume execution.
const SM0_PINCTRL = 0x0dc; //State machine pin control
const SM1_CLKDIV = 0x0e0;
const SM1_PINCTRL = 0x0f4;
const SM2_CLKDIV = 0x0f8;
const SM2_PINCTRL = 0x10c;
const SM3_CLKDIV = 0x110;
const SM3_PINCTRL = 0x124;

// FSTAT bits
const FSTAT_TXEMPTY = 1 << 24;
const FSTAT_TXFULL = 1 << 16;
const FSTAT_RXEMPTY = 1 << 8;
const FSTAT_RXFULL = 1 << 0;

// FDEBUG bits
const FDEBUG_TXSTALL = 1 << 24;
const FDEBUG_TXOVER = 1 << 16;
const FDEBUG_RXUNDER = 1 << 8;
const FDEBUG_RXSTALL = 1 << 0;

// SHIFTCTRL bits
const SHIFTCTRL_FJOIN_RX = 1 << 31;
const SHIFTCTRL_FJOIN_TX = 1 << 30;
const SHIFTCTRL_AUTOPUSH = 1 << 16;
const SHIFTCTRL_AUTOPULL = 1 << 17;
const SHIFTCTRL_IN_SHIFTDIR = 1 << 18; // 1 = shift input shift register to right (data enters from left). 0 = to left
const SHIFTCTRL_OUT_SHIFTDIR = 1 << 19; // 1 = shift out of output shift register to right. 0 = to left

// EXECCTRL bits
const EXECCTRL_STATUS_SEL = 1 << 4;
const EXECCTRL_SIDE_PINDIR = 1 << 29;
const EXECCTRL_SIDE_EN = 1 << 30;
const EXECCTRL_EXEC_STALLED = 1 << 31;

// TODO(RP2350) RXF0_PUTGET0 expose each RX FIFO's internal storage registers
// TODO(RP2350) FJOIN_RX_GET FIFO mode
// TODO(RP2350) FJOIN_RX_PUT FIFO mode

export enum WaitType {
  None,
  Pin,
  rxFIFO,
  txFIFO,
  IRQ,
  Out, // Out instruction
}

interface IrqTarget {
  targetPio: RPPIO;
  irqBit: number;
}

function bitReverse(x: number) {
  x = ((x & 0x55555555) << 1) | ((x & 0xaaaaaaaa) >>> 1);
  x = ((x & 0x33333333) << 2) | ((x & 0xcccccccc) >>> 2);
  x = ((x & 0x0f0f0f0f) << 4) | ((x & 0xf0f0f0f0) >>> 4);
  x = ((x & 0x00ff00ff) << 8) | ((x & 0xff00ff00) >>> 8);
  x = ((x & 0x0000ffff) << 16) | ((x & 0xffff0000) >>> 16);
  return x >>> 0;
}

export class StateMachine<ChipType extends IRPChip = IRPChip> {
  private _enabled = false;

  // State machine registers
  x: number = 0;
  y: number = 0;
  pc: number = 0;
  inputShiftReg = 0;
  inputShiftCount = 0;
  outputShiftReg = 0;
  outputShiftCount = 0;
  cycles = 0;

  execOpcode: number = 0;
  execValid = false;
  nextPC: number = 0;

  clockDiv: number = 256; // INT*256 + FRAC
  curClockPhase: number = 0;
  remainingDelay: number = 0;
  execCtrl = 0x1f << 12;
  shiftCtrl = 0b11 << 18;
  pinCtrl = 0x5 << 26;
  rxFIFO = new FIFO(4);
  txFIFO = new FIFO(4);

  outPinValues: number = 0;
  outPinDirection: number = 0;

  waiting = false;
  waitType = WaitType.None;
  waitIndex = 0;
  waitPolarity = false;
  waitDelay = -1;
  waitTargetPio: RPPIO = this.pio;

  readonly dreqRx = this.pio.dreqRx_base + this.index;
  readonly dreqTx = this.pio.dreqTx_base + this.index;

  // Reused scratch output for resolveIrqTarget() (see its own comment) — no inline
  // initializer (would run before the `pio` param property is assigned); set from
  // the constructor's `pio` parameter instead.
  private readonly irqTargetScratch: IrqTarget;

  constructor(readonly rp2040: ChipType, readonly pio: RPPIO, readonly index: number) {
    this.irqTargetScratch = { targetPio: pio, irqBit: 0 };
    this.updateDMARx();
    this.updateDMATx();
  }

  private updateDMATx() {
    if (this.txFIFO.full) {
      this.rp2040.dma_clearDREQ(this.dreqTx);
    } else {
      this.rp2040.dma_setDREQ(this.dreqTx);
    }
  }

  private updateDMARx() {
    if (this.rxFIFO.empty) {
      this.rp2040.dma_clearDREQ(this.dreqRx);
    } else {
      this.rp2040.dma_setDREQ(this.dreqRx);
    }
  }

  writeFIFO(value: number) {
    if (this.txFIFO.full) {
      this.pio.fdebug |= FDEBUG_TXOVER << this.index;
      return;
    }
    this.txFIFO.push(value);
    this.updateDMATx();
    this.checkWait();
    if (this.txFIFO.full) {
      this.pio.checkInterrupts();
    }
  }

  readFIFO() {
    if (this.rxFIFO.empty) {
      this.pio.fdebug |= FDEBUG_RXUNDER << this.index;
      return 0;
    }
    const result = this.rxFIFO.pull();
    this.updateDMARx();
    this.checkWait();
    if (this.rxFIFO.empty) {
      this.pio.checkInterrupts();
    }
    return result;
  }

  get status() {
    const statusN = this.execCtrl & 0xf;
    if (this.execCtrl & EXECCTRL_STATUS_SEL) {
      return this.rxFIFO.itemCount < statusN ? 0xffffffff : 0;
    } else {
      return this.txFIFO.itemCount < statusN ? 0xffffffff : 0;
    }
  }

  set enabled(value: boolean) {
    this._enabled = value;
    if (value) {
      this.pio.machinesRunning |= 1 << this.index;
    } else {
      this.pio.machinesRunning &= ~(1 << this.index);
    }
    this.rp2040.updatePioActiveLists();
  }

  get enabled() {
    return this._enabled;
  }

  jmpCondition(condition: number) {
    switch (condition) {
      // (no condition): Always
      case 0b000:
        return true;

      // !X: scratch X zero
      case 0b001:
        return this.x === 0;

      // X--: scratch X non-zero, post-decrement
      case 0b010: {
        const oldX = this.x;
        this.x = (this.x - 1) >>> 0;
        return oldX !== 0;
      }

      // !Y: scratch Y zero
      case 0b011:
        return this.y === 0;

      // Y--: scratch Y non-zero, post-decrement
      case 0b100: {
        const oldY = this.y;
        this.y = (this.y - 1) >>> 0;
        return oldY !== 0;
      }

      // X!=Y: scratch X not equal scratch Y
      case 0b101:
        return this.x >>> 0 !== this.y >>> 0;

      // PIN: branch on input pin
      case 0b110: {
        const { gpio } = this.rp2040;
        const { jmpPin } = this;
        return jmpPin < gpio.length ? gpio[jmpPin].inputValue : false;
      }

      // !OSRE: output shift register not empty
      case 0b111:
        return this.outputShiftCount < this.pullThreshold;
    }

    this.pio.error(`jmpCondition with unsupported condition: ${condition}`);
    return false;
  }

  get inCountMask() {
    // IN_COUNT: RP2350 only, number of LSB pins NOT to mask to 0 in IN PINS/WAIT PIN/MOV x,PINS (0 = keep all pins)
    if (!this.pio.isRp2040) {
      const value = this.shiftCtrl & 0b11111;
      return value ? ((1 << value) >>> 0) - 1 : 0xffffffff;
    }
    return 0xffffffff;
  }

  get inPins() {
    const gpioValues = this.rp2040.gpioValues(this.pio.gpiobase);
    const { inBase } = this;
    return inBase ? (gpioValues << (32 - inBase)) | (gpioValues >>> inBase) : gpioValues;
  }

  inSourceValue(source: number) {
    switch (source) {
      // PINS
      case 0b000:
        return this.inPins & this.inCountMask;

      // X (scratch register X)
      case 0b001:
        return this.x;

      // Y (scratch register Y)
      case 0b010:
        return this.y;

      // NULL (all zeroes)
      case 0b011:
        return 0;

      // Reserved
      case 0b100:
        return 0;

      // Reserved for IN, STATUS for MOV
      case 0b101:
        return this.status;

      // ISR
      case 0b110:
        return this.inputShiftReg;

      // OSR
      case 0b111:
        return this.outputShiftReg;
    }

    this.pio.error(`inSourceValue with unsupported source: ${source}`);
    return 0;
  }

  writeOutValue(destination: number, value: number, bitCount: number) {
    switch (destination) {
      // PINS
      case 0b000:
        this.setOutPins(value);
        break;

      // X (scratch register X)
      case 0b001:
        this.x = value;
        break;

      // Y (scratch register Y)
      case 0b010:
        this.y = value;
        break;

      // NULL (discard data)
      case 0b011:
        break;

      // PINDIRS
      case 0b100:
        this.setOutPinDirs(value);
        break;

      // PC
      case 0b101:
        this.nextPC = value & 0x1f;
        break;

      // ISR (also sets ISR shift counter to Bit count)
      case 0b110:
        this.inputShiftReg = value;
        this.inputShiftCount = bitCount;
        break;

      // EXEC (Execute OSR shift data as instruction)
      case 0b111:
        this.execOpcode = value;
        this.execValid = true;
        break;
    }
  }

  get pushThreshold() {
    const value = (this.shiftCtrl >> 20) & 0x1f;
    return value ? value : 32;
  }

  get pullThreshold() {
    const value = (this.shiftCtrl >> 25) & 0x1f;
    return value ? value : 32;
  }

  get sidesetCount() {
    return (this.pinCtrl >> 29) & 0x7;
  }

  get setCount() {
    return (this.pinCtrl >> 26) & 0x7;
  }

  get outCount() {
    return (this.pinCtrl >> 20) & 0x3f;
  }

  get inBase() {
    return (this.pinCtrl >> 15) & 0x1f;
  }

  get sidesetBase() {
    return (this.pinCtrl >> 10) & 0x1f;
  }

  get setBase() {
    return (this.pinCtrl >> 5) & 0x1f;
  }

  get outBase() {
    return (this.pinCtrl >> 0) & 0x1f;
  }

  get jmpPin() {
    return (this.execCtrl >> 24) & 0x1f;
  }

  get wrapTop() {
    return (this.execCtrl >> 12) & 0x1f;
  }

  get wrapBottom() {
    return (this.execCtrl >> 7) & 0x1f;
  }

  setOutPinDirs(value: number) {
    this.outPinDirection = value;
    this.pio.pinDirectionsChanged(value, this.outBase, this.outCount);
  }

  setOutPins(value: number) {
    this.outPinValues = value;
    this.pio.pinValuesChanged(value, this.outBase, this.outCount);
  }

  outInstruction(arg: number) {
    const bitCount = arg & 0x1f;
    const destination = arg >> 5;

    if (bitCount === 0) {
      this.writeOutValue(destination, this.outputShiftReg, 32);
      this.outputShiftCount = 32;
    } else {
      if (this.shiftCtrl & SHIFTCTRL_OUT_SHIFTDIR) {
        const value = this.outputShiftReg & ((1 << bitCount) - 1);
        this.outputShiftReg >>>= bitCount;
        this.writeOutValue(destination, value, bitCount);
      } else {
        const value = this.outputShiftReg >>> (32 - bitCount);
        this.outputShiftReg <<= bitCount;
        this.writeOutValue(destination, value, bitCount);
      }
      this.outputShiftCount += bitCount;
      if (this.outputShiftCount > 32) {
        this.outputShiftCount = 32;
      }
    }
  }

  executeInstruction(opcode: number) {
    const arg = opcode & 0xff;
    switch (opcode >>> 13) {
      /* JMP */
      case 0b000:
        if (this.jmpCondition(arg >> 5)) {
          this.nextPC = arg & 0x1f;
        }
        break;

      /* WAIT */
      case 0b001: {
        const polarity = !!(arg & 0x80);
        const source = (arg >> 5) & 0x3;
        const index = arg & 0x1f;
        switch (source) {
          // TODO(RP2350) PINCTRL_JMP_PIN source
          // GPIO:
          case 0b00:
            this.wait(WaitType.Pin, polarity, index);
            break;

          // PIN:
          case 0b01:
            this.wait(WaitType.Pin, polarity, (index + this.inBase) % 32);
            break;

          // IRQ:
          case 0b10: {
            this.resolveIrqTarget(index, this.irqTargetScratch);
            this.wait(
              WaitType.IRQ,
              polarity,
              this.irqTargetScratch.irqBit,
              this.irqTargetScratch.targetPio
            );
            break;
          }
        }
        break;
      }

      /* IN */
      case 0b010: {
        const bitCount = arg & 0x1f;
        let sourceValue = this.inSourceValue(arg >> 5);

        if (bitCount == 0) {
          this.inputShiftReg = sourceValue;
          this.inputShiftCount = 32;
        } else {
          sourceValue &= (1 << bitCount) - 1;
          if (this.shiftCtrl & SHIFTCTRL_IN_SHIFTDIR) {
            this.inputShiftReg >>>= bitCount;
            this.inputShiftReg |= sourceValue << (32 - bitCount);
          } else {
            this.inputShiftReg <<= bitCount;
            this.inputShiftReg |= sourceValue;
          }
          this.inputShiftCount += bitCount;
          if (this.inputShiftCount > 32) {
            this.inputShiftCount = 32;
          }
        }

        if (this.shiftCtrl & SHIFTCTRL_AUTOPUSH && this.inputShiftCount >= this.pushThreshold) {
          if (!this.rxFIFO.full) {
            this.rxFIFO.push(this.inputShiftReg);
            this.updateDMARx();
            this.pio.checkInterrupts();
          } else {
            this.pio.fdebug |= FDEBUG_RXSTALL << this.index;
            this.wait(WaitType.rxFIFO, false, this.inputShiftReg);
          }
          this.inputShiftCount = 0;
          this.inputShiftReg = 0;
        }

        break;
      }

      /* OUT */
      case 0b011: {
        if (this.shiftCtrl & SHIFTCTRL_AUTOPULL && this.outputShiftCount >= this.pullThreshold) {
          this.outputShiftCount = 0;
          if (!this.txFIFO.empty) {
            this.outputShiftReg = this.txFIFO.pull();
            this.updateDMATx();
            this.pio.checkInterrupts();
          } else {
            this.pio.fdebug |= FDEBUG_TXSTALL << this.index;
            this.wait(WaitType.Out, false, arg);
          }
        }

        if (!this.waiting) {
          this.outInstruction(arg);
        }
        break;
      }

      /* PUSH/PULL */
      case 0b100: {
        const block = !!(arg & (1 << 5));
        const ifFullOrEmpty = !!(arg & (1 << 6));
        if (arg & 0x1f) {
          // Unknown instruction
          break;
        }
        if (arg & 0x80) {
          // PULL
          if (
            ifFullOrEmpty &&
            this.shiftCtrl & SHIFTCTRL_AUTOPULL &&
            this.outputShiftCount < this.pullThreshold
          ) {
            break;
          }
          if (!this.txFIFO.empty) {
            this.outputShiftReg = this.txFIFO.pull();
            this.updateDMATx();
            this.pio.checkInterrupts();
          } else {
            this.pio.fdebug |= FDEBUG_TXSTALL << this.index;
            if (block) {
              this.wait(WaitType.txFIFO, false, 0);
            } else {
              this.outputShiftReg = this.x;
            }
          }
          this.outputShiftCount = 0;
        } else {
          // PUSH
          if (
            ifFullOrEmpty &&
            this.shiftCtrl & SHIFTCTRL_AUTOPUSH &&
            this.inputShiftCount < this.pushThreshold
          ) {
            break;
          }
          if (!this.rxFIFO.full) {
            this.rxFIFO.push(this.inputShiftReg);
            this.updateDMARx();
            this.pio.checkInterrupts();
          } else {
            this.pio.fdebug |= FDEBUG_RXSTALL << this.index;
            if (block) {
              this.wait(WaitType.rxFIFO, false, this.inputShiftReg);
            }
          }
          this.inputShiftReg = 0;
          this.inputShiftCount = 0;
        }
        break;
      }

      /* MOV */
      case 0b101: {
        const source = arg & 0x7;
        const op = (arg >> 3) & 0x3;
        // TODO(RP2350) PINDIRS destination
        // TODO(RP2350) SM IRQ flags as a source for MOV x, STATUS
        const destination = (arg >> 5) & 0x7;
        const value = this.inSourceValue(source);
        const transformedValue = this.transformMovValue(value, op) >>> 0;
        this.setMovDestination(destination, transformedValue);
        break;
      }

      /* IRQ */
      case 0b110: {
        if (arg & 0x80) {
          // Unknown instruction
          break;
        }
        const clear = !!(arg & 0x40);
        const wait = !!(arg & 0x20);
        this.resolveIrqTarget(arg & 0x1f, this.irqTargetScratch);
        const { targetPio, irqBit } = this.irqTargetScratch;
        if (clear) {
          targetPio.irq &= ~(1 << irqBit);
          targetPio.irqUpdated();
        } else {
          targetPio.irq |= 1 << irqBit;
          targetPio.irqUpdated();
          if (wait) {
            this.wait(WaitType.IRQ, false, irqBit, targetPio);
          }
        }
        break;
      }

      /* SET */
      case 0b111: {
        const data = arg & 0x1f;
        const destination = arg >> 5;
        switch (destination) {
          case 0b000:
            this.setSetPins(data);
            break;
          case 0b001:
            this.x = data;
            break;
          case 0b010:
            this.y = data;
            break;
          case 0b100:
            this.setSetPinDirs(data);
            break;
        }
        break;
      }
    }

    const { sidesetCount, execCtrl } = this;
    const delaySideset = (opcode >> 8) & 0x1f;
    const sideEn = !!(execCtrl & EXECCTRL_SIDE_EN);
    const delay = delaySideset & ((1 << (5 - sidesetCount)) - 1);

    if (sidesetCount && (!sideEn || delaySideset & 0x10)) {
      const sideset = delaySideset >> (5 - sidesetCount);
      this.setSideset(sideset, sideEn ? sidesetCount - 1 : sidesetCount);
    }

    if (this.execValid) {
      this.execValid = false;
      this.remainingDelay += 1; // delay on EXEC is ignored but EXEC takes 1 cycle
      this.executeInstruction(this.execOpcode);
    } else if (this.waiting) {
      if (this.waitDelay < 0) {
        this.waitDelay = delay;
      }
      this.checkWait();
    } else {
      this.remainingDelay += delay;
    }
  }

  // Writes the resolved target into `out` (the caller's own IrqTarget, e.g.
  // irqTargetScratch below) instead of returning a fresh object — an object-literal
  // return heap-allocates in C, and this is called on every IRQ-related PIO
  // instruction (WAIT-on-IRQ, SET/CLEAR-IRQ). An out-param needs no allocation.
  resolveIrqTarget(irqField: number, out: IrqTarget): void {
    const pio = this.pio;
    if (pio.isRp2040) {
      const rel = !!(irqField & 0x10);
      const irqBit = rel
        ? (irqField & 0x4) | (((irqField & 0x3) + this.index) & 0x3)
        : irqField & 0x7;
      out.targetPio = pio;
      out.irqBit = irqBit;
      return;
    }
    const idxMode = (irqField >> 3) & 3;
    const irqNum = irqField & 7;
    switch (idxMode) {
      case 0:
        out.targetPio = pio;
        out.irqBit = irqNum;
        return;
      case 1: {
        const pioCount = this.rp2040.pio.length;
        const prevPio = this.rp2040.pio[(pio.index + pioCount - 1) % pioCount];
        out.targetPio = prevPio;
        out.irqBit = irqNum;
        return;
      }
      case 2:
        out.targetPio = pio;
        out.irqBit = (irqNum & 4) | ((irqNum + this.index) & 3);
        return;
      case 3: {
        const nextPio = this.rp2040.pio[(pio.index + 1) % this.rp2040.pio.length];
        out.targetPio = nextPio;
        out.irqBit = irqNum;
        return;
      }
      default:
        out.targetPio = pio;
        out.irqBit = irqNum;
    }
  }

  wait(type: WaitType, polarity: boolean, index: number, targetPio?: RPPIO) {
    this.waiting = true;
    this.waitType = type;
    this.waitPolarity = polarity;
    this.waitIndex = index;
    this.waitDelay = -1;
    this.waitTargetPio = targetPio ?? this.pio;
  }

  step() {
    if (this._enabled) {
      this.stepUnchecked();
    }
  }

  /** Steps the machine, assuming the caller has already checked `enabled`. */
  stepUnchecked() {
    // Fractional clock divider via phase accumulator: advance by 256 each
    // sys_clk cycle, execute when phase >= INT*256+FRAC.
    this.curClockPhase += 256;
    if (this.curClockPhase < this.clockDiv) {
      return;
    }
    this.curClockPhase -= this.clockDiv;

    this.cycles++;

    if (this.remainingDelay > 0) {
      this.remainingDelay--;
      return;
    }

    if (this.waiting) {
      this.checkWait();
      if (this.waiting) {
        this.cycles++;
        return;
      }
      if (this.remainingDelay > 0) {
        this.remainingDelay--;
        return;
      }
    }

    this.pc = this.nextPC & 0x1f;
    this.nextPC = this.pc === this.wrapTop ? this.wrapBottom : this.pc + 1; // set default next PC
    this.executeInstruction(this.pio.instructions[this.pc]);
  }

  setSetPinDirs(value: number) {
    this.pio.pinDirectionsChanged(value, this.setBase, this.setCount);
  }

  setSetPins(value: number) {
    this.pio.pinValuesChanged(value, this.setBase, this.setCount);
  }

  setSideset(value: number, count: number) {
    if (this.execCtrl & EXECCTRL_SIDE_PINDIR) {
      this.pio.pinDirectionsChanged(value, this.sidesetBase, count);
    } else {
      this.pio.pinValuesChanged(value, this.sidesetBase, count);
    }
  }

  transformMovValue(value: number, op: number) {
    switch (op) {
      case 0b00:
        return value;
      case 0b01:
        return ~value;
      case 0b10:
        return bitReverse(value);
      case 0b11:
      default:
        return value; // reserved
    }
  }

  setMovDestination(destination: number, value: number) {
    switch (destination) {
      // PINS
      case 0b000:
        this.setOutPins(value);
        break;

      // X (scratch register X)
      case 0b001:
        this.x = value;
        break;

      // Y (scratch register Y)
      case 0b010:
        this.y = value;
        break;

      // reserved (discard data)
      case 0b011:
        break;

      // EXEC
      case 0b100:
        this.execOpcode = value;
        this.execValid = true;
        break;

      // PC
      case 0b101:
        this.nextPC = value & 0x1f;
        break;

      // ISR (Input shift counter is reset to 0 by this operation, i.e. empty)
      case 0b110:
        this.inputShiftReg = value;
        this.inputShiftCount = 0;
        break;

      // OSR (Output shift counter is reset to 0 by this operation, i.e. full)
      case 0b111:
        this.outputShiftReg = value;
        this.outputShiftCount = 0;
        break;
    }
  }

  readUint32(offset: number) {
    switch (offset + SM0_CLKDIV) {
      case SM0_CLKDIV:
        return ((this.clockDiv / 256) << 16) | (((this.clockDiv & 0xff) << 8) >>> 0);
      case SM0_EXECCTRL:
        return this.execCtrl;
      case SM0_SHIFTCTRL:
        return this.shiftCtrl;
      case SM0_ADDR:
        return this.pc;
      case SM0_INSTR:
        return this.pio.instructions[this.pc];
      case SM0_PINCTRL:
        return this.pinCtrl;
    }
    this.pio.error(`Read from invalid state machine register: ${offset}`);
    return 0;
  }

  writeUint32(offset: number, value: number) {
    switch (offset + SM0_CLKDIV) {
      case SM0_CLKDIV:
        this.clockDiv = (value >>> 16) * 256 + ((value >>> 8) & 0xff);
        break;
      case SM0_EXECCTRL:
        this.execCtrl = ((value & 0x7fffffff) | (this.execCtrl & 0x80000000)) >>> 0;
        break;
      case SM0_SHIFTCTRL:
        if ((value >>> 30) ^ (this.shiftCtrl >>> 30)) {
          if (value & SHIFTCTRL_FJOIN_RX) {
            this.rxFIFO = new FIFO(8);
            this.txFIFO = new FIFO(0);
          } else if (value & SHIFTCTRL_FJOIN_TX) {
            this.rxFIFO = new FIFO(0);
            this.txFIFO = new FIFO(8);
          } else {
            this.rxFIFO = new FIFO(4);
            this.txFIFO = new FIFO(4);
          }
          this.updateDMATx();
          this.updateDMARx();
        }
        this.shiftCtrl = value;
        break;
      case SM0_ADDR:
        /* read-only */
        break;
      case SM0_INSTR:
        this.executeInstruction(value & 0xffff);
        if (this.waiting) {
          this.execCtrl |= EXECCTRL_EXEC_STALLED;
        }
        break;
      case SM0_PINCTRL:
        this.pinCtrl = value;
        break;
      default:
        this.pio.error(`Write to invalid state machine register: ${offset}`);
    }
  }

  get fifoStat() {
    const result =
      (this.txFIFO.empty ? FSTAT_TXEMPTY : 0) |
      (this.txFIFO.full ? FSTAT_TXFULL : 0) |
      (this.rxFIFO.empty ? FSTAT_RXEMPTY : 0) |
      (this.rxFIFO.full ? FSTAT_RXFULL : 0);
    return result << this.index;
  }

  restart() {
    this.cycles = 0;
    this.curClockPhase = 0;
    this.remainingDelay = 0;
    this.inputShiftCount = 0;
    this.outputShiftCount = 32;
    this.inputShiftReg = 0;
    this.waiting = false;
    // TODO any pin write left asserted due to OUT_STICKY.
  }

  clkDivRestart() {
    this.curClockPhase = 0;
  }

  checkWait() {
    if (!this.waiting) {
      return;
    }

    switch (this.waitType) {
      case WaitType.IRQ: {
        const targetPio = this.waitTargetPio;
        const irqValue = !!(targetPio.irq & (1 << this.waitIndex));
        if (irqValue === this.waitPolarity) {
          this.waiting = false;
          if (irqValue) {
            targetPio.irq &= ~(1 << this.waitIndex);
          }
          if (targetPio !== this.pio) {
            targetPio.irqUpdated();
          }
        }
        break;
      }

      case WaitType.Pin: {
        if (
          this.waitIndex < this.rp2040.gpio.length &&
          this.rp2040.gpio[this.waitIndex + this.pio.gpiobase].inputValue === this.waitPolarity
        ) {
          this.waiting = false;
        }
        break;
      }

      case WaitType.rxFIFO: {
        if (!this.rxFIFO.full) {
          this.rxFIFO.push(this.waitIndex);
          this.waiting = false;
          this.updateDMARx();
          this.pio.checkInterrupts();
        }
        break;
      }

      case WaitType.txFIFO: {
        if (!this.txFIFO.empty) {
          this.outputShiftReg = this.txFIFO.pull();
          this.waiting = false;
          this.updateDMATx();
          this.pio.checkInterrupts();
        }
        break;
      }

      case WaitType.Out: {
        if (!this.txFIFO.empty) {
          this.outputShiftReg = this.txFIFO.pull();
          this.outInstruction(this.waitIndex);
          this.waiting = false;
          this.updateDMATx();
          this.pio.checkInterrupts();
        }
        break;
      }
    }

    if (!this.waiting) {
      this.remainingDelay += this.waitDelay;
      this.execCtrl &= ~EXECCTRL_EXEC_STALLED;
    }
  }
}

export class RPPIO<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  readonly instructions = new Uint32Array(32);
  readonly machines = [
    new StateMachine(this.rp2040, this, 0),
    new StateMachine(this.rp2040, this, 1),
    new StateMachine(this.rp2040, this, 2),
    new StateMachine(this.rp2040, this, 3),
  ];

  machinesRunning = 0;
  fdebug = 0;
  inputSyncBypass = 0;
  irq = 0;
  isRp2040 = this.rp2040.identifier == 'rp2040';
  gpiobase = 0;
  pinValues = 0;
  pinDirections = 0;
  oldPinValues = 0;
  oldPinDirections = 0;
  private runTimer: NodeJS.Timeout | null = null;

  irq_reg_offset = 0;

  irq0IntEnable = 0;
  irq0IntForce = 0;
  irq1IntEnable = 0;
  irq1IntForce = 0;

  constructor(
    rp2040: ChipType,
    name: string,
    readonly firstIrq: number,
    readonly index: number,
    readonly dreqRx_base: number,
    readonly dreqTx_base: number
  ) {
    super(rp2040, name);
    switch (rp2040.identifier) {
      case 'rp2040':
        break;
      case 'rp2350':
        this.irq_reg_offset = RP2350_INTR - INTR;
        break;
      default:
        throw new Error('Unknown chip id');
    }
  }

  get stopped() {
    return !this.machinesRunning;
  }

  get intRaw() {
    return (
      ((this.irq & 0xf) << 8) |
      (!this.machines[3].txFIFO.full ? 0x80 : 0) |
      (!this.machines[2].txFIFO.full ? 0x40 : 0) |
      (!this.machines[1].txFIFO.full ? 0x20 : 0) |
      (!this.machines[0].txFIFO.full ? 0x10 : 0) |
      (!this.machines[3].rxFIFO.empty ? 0x08 : 0) |
      (!this.machines[2].rxFIFO.empty ? 0x04 : 0) |
      (!this.machines[1].rxFIFO.empty ? 0x02 : 0) |
      (!this.machines[0].rxFIFO.empty ? 0x01 : 0)
    );
  }

  get irq0IntStatus() {
    return (this.intRaw & this.irq0IntEnable) | this.irq0IntForce;
  }

  get irq1IntStatus() {
    return (this.intRaw & this.irq1IntEnable) | this.irq1IntForce;
  }

  readUint32(offset: number) {
    if (offset >= SM0_CLKDIV && offset <= SM0_PINCTRL) {
      return this.machines[0].readUint32(offset - SM0_CLKDIV);
    }
    if (offset >= SM1_CLKDIV && offset <= SM1_PINCTRL) {
      return this.machines[1].readUint32(offset - SM1_CLKDIV);
    }
    if (offset >= SM2_CLKDIV && offset <= SM2_PINCTRL) {
      return this.machines[2].readUint32(offset - SM2_CLKDIV);
    }
    if (offset >= SM3_CLKDIV && offset <= SM3_PINCTRL) {
      return this.machines[3].readUint32(offset - SM3_CLKDIV);
    }

    switch (offset) {
      case CTRL:
        return this.machinesRunning;
      case FSTAT:
        return (
          this.machines[0].fifoStat |
          this.machines[1].fifoStat |
          this.machines[2].fifoStat |
          this.machines[3].fifoStat
        );
      case FDEBUG:
        return this.fdebug;
      case FLEVEL:
        return (
          (this.machines[0].txFIFO.itemCount & 0xf) |
          ((this.machines[0].rxFIFO.itemCount & 0xf) << 4) |
          ((this.machines[1].txFIFO.itemCount & 0xf) << 8) |
          ((this.machines[1].rxFIFO.itemCount & 0xf) << 12) |
          ((this.machines[2].txFIFO.itemCount & 0xf) << 16) |
          ((this.machines[2].rxFIFO.itemCount & 0xf) << 20) |
          ((this.machines[3].txFIFO.itemCount & 0xf) << 24) |
          ((this.machines[3].rxFIFO.itemCount & 0xf) << 28)
        );

      case RXF0:
        return this.machines[0].readFIFO();
      case RXF1:
        return this.machines[1].readFIFO();
      case RXF2:
        return this.machines[2].readFIFO();
      case RXF3:
        return this.machines[3].readFIFO();
      case IRQ_REG:
        return this.irq;
      case IRQ_FORCE:
        return 0;
      case INPUT_SYNC_BYPASS:
        return this.inputSyncBypass;
      case DBG_PADOUT:
        return this.pinValues;
      case DBG_PADOE:
        return this.pinDirections;
      case DBG_CFGINFO:
        return 0x200404;
      case INTR + this.irq_reg_offset:
        return this.intRaw;
      case IRQ0_INTE + this.irq_reg_offset:
        return this.irq0IntEnable;
      case IRQ0_INTF + this.irq_reg_offset:
        return this.irq0IntForce;
      case IRQ0_INTS + this.irq_reg_offset:
        return this.irq0IntStatus;
      case IRQ1_INTE + this.irq_reg_offset:
        return this.irq1IntEnable;
      case IRQ1_INTF + this.irq_reg_offset:
        return this.irq1IntForce;
      case IRQ1_INTS + this.irq_reg_offset:
        return this.irq1IntStatus;
      case RP2350_GPIOBASE:
        if (!this.isRp2040) {
          return this.gpiobase;
        }
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset >= INSTR_MEM0 && offset <= INSTR_MEM31) {
      const index = (offset - INSTR_MEM0) >> 2;
      this.instructions[index] = value & 0xffff;
      return;
    }
    if (offset >= SM0_CLKDIV && offset <= SM0_PINCTRL) {
      this.machines[0].writeUint32(offset - SM0_CLKDIV, value);
      return;
    }
    if (offset >= SM1_CLKDIV && offset <= SM1_PINCTRL) {
      this.machines[1].writeUint32(offset - SM1_CLKDIV, value);
      return;
    }
    if (offset >= SM2_CLKDIV && offset <= SM2_PINCTRL) {
      this.machines[2].writeUint32(offset - SM2_CLKDIV, value);
      return;
    }
    if (offset >= SM3_CLKDIV && offset <= SM3_PINCTRL) {
      this.machines[3].writeUint32(offset - SM3_CLKDIV, value);
      return;
    }
    switch (offset) {
      case CTRL: {
        for (let index = 0; index < 4; index++) {
          this.machines[index].enabled = value & (1 << index) ? true : false;
          if (value & (1 << (4 + index))) {
            this.machines[index].restart();
          }
          if (value & (1 << (8 + index))) {
            this.machines[index].clkDivRestart();
          }
        }
        if (!this.isRp2040) {
          // RP2350 functionality to restart "neighboring" PIO machines synchronously
          const enableSm = !!(value & (1 << 24));
          const disableSm = !!(value & (1 << 25));
          const clkDivRestart = !!(value & (1 << 26));

          // consider "previous" PIO on first for loop
          const pioCount = this.rp2040.pio.length;
          let affectedPio = this.rp2040.pio[(this.index + pioCount - 1) % pioCount];
          let affectedMachines = value >>> 16;
          for (let prevNext = 0; prevNext <= 1; prevNext++) {
            for (let index = 0; index < 4; index++) {
              if (affectedMachines & (1 << index)) {
                if (enableSm) affectedPio.machines[index].enabled = true;
                if (disableSm) affectedPio.machines[index].enabled = false;
                if (clkDivRestart) affectedPio.machines[index].clkDivRestart();
              }
            }
            // consider "next" PIO on second for loop
            affectedPio = this.rp2040.pio[(this.index + 1) % pioCount];
            affectedMachines = value >>> 20;
          }
        }
        break;
      }
      case FDEBUG:
        this.fdebug &= ~this.rawWriteValue;
        break;
      case TXF0:
        this.machines[0].writeFIFO(value);
        break;
      case TXF1:
        this.machines[1].writeFIFO(value);
        break;
      case TXF2:
        this.machines[2].writeFIFO(value);
        break;
      case TXF3:
        this.machines[3].writeFIFO(value);
        break;
      case IRQ_REG:
        this.irq &= ~this.rawWriteValue;
        this.irqUpdated();
        break;
      case INPUT_SYNC_BYPASS:
        this.inputSyncBypass = value;
        break;
      case IRQ_FORCE:
        this.irq |= value;
        this.irqUpdated();
        break;
      case IRQ0_INTE + this.irq_reg_offset:
        this.irq0IntEnable = value & 0xfff;
        this.checkInterrupts();
        break;
      case IRQ0_INTF + this.irq_reg_offset:
        this.irq0IntForce = value & 0xfff;
        this.checkInterrupts();
        break;
      case IRQ1_INTE + this.irq_reg_offset:
        this.irq1IntEnable = value & 0xfff;
        this.checkInterrupts();
        break;
      case IRQ1_INTF + this.irq_reg_offset:
        this.irq1IntForce = value & 0xfff;
        this.checkInterrupts();
        break;
      case RP2350_GPIOBASE:
        // rp2040 has no GPIOBASE register, so it takes the same path as an unknown offset.
        if (this.rp2040.identifier != 'rp2040') {
          this.gpiobase = value & 16;
        } else {
          super.writeUint32(offset, value);
        }
        break;
      default:
        super.writeUint32(offset, value);
    }
  }

  getPinValue(chip_gpio_index: number) {
    const index = chip_gpio_index - this.gpiobase;
    if (index < 0 || index > 31) return false;
    return !!(this.pinValues & (1 << index));
  }

  getPinOutputEnabled(chip_gpio_index: number) {
    const index = chip_gpio_index - this.gpiobase;
    if (index < 0 || index > 31) return false;
    return !!(this.pinDirections & (1 << index));
  }

  pinValuesChanged(value: number, firstPin: number, count: number) {
    // TODO: wrapping after pin 31
    const mask = count > 31 ? 0xffffffff : ((1 << count) - 1) << firstPin;
    const newValue =
      ((this.pinValues & ~mask) | ((value << firstPin) & mask)) &
      (this.isRp2040 ? 0x3fffffff : 0xffffffff);
    this.pinValues = newValue;
  }

  pinDirectionsChanged(value: number, firstPin: number, count: number) {
    // TODO: wrapping after pin 31
    const mask = count > 31 ? 0xffffffff : ((1 << count) - 1) << firstPin;
    const newValue =
      ((this.pinDirections & ~mask) | ((value << firstPin) & mask)) &
      (this.isRp2040 ? 0x3fffffff : 0xffffffff);
    this.pinDirections = newValue;
  }

  checkInterrupts() {
    const { firstIrq } = this;
    this.rp2040.setInterrupt(firstIrq, !!this.irq0IntStatus);
    this.rp2040.setInterrupt(firstIrq + 1, !!this.irq1IntStatus);
  }

  irqUpdated() {
    for (const machine of this.machines) {
      machine.checkWait();
    }
    this.checkInterrupts();
  }

  checkChangedPins() {
    const changedPins =
      (this.oldPinDirections ^ this.pinDirections) | (this.oldPinValues ^ this.pinValues);
    if (changedPins) {
      this.oldPinDirections = this.pinDirections;
      this.oldPinValues = this.pinValues;

      // Notify GPIO about the changed pins
      const { gpio } = this.rp2040;
      for (let pinIndex = 0; pinIndex < 32; pinIndex++) {
        if (changedPins & (1 << pinIndex)) {
          gpio[pinIndex + this.gpiobase].checkForUpdates();
        }
      }
    }
  }

  step() {
    if (this.stopped) {
      return;
    }
    // `machinesRunning` (synced with each machine's `enabled` setter) skips disabled
    // machines without calling StateMachine.step() — this runs every cycle for every
    // PIO, so otherwise each disabled machine would pay a full call just to bail out
    // immediately.
    for (let i = 0; i < this.machines.length; i++) {
      if (this.machinesRunning & (1 << i)) {
        this.machines[i].stepUnchecked();
      }
    }
    this.checkChangedPins();
  }

  stop() {
    for (const machine of this.machines) {
      machine.enabled = false;
    }
    if (this.runTimer) {
      clearTimeout(this.runTimer);
      this.runTimer = null;
    }
  }
}
