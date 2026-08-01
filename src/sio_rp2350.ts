import type { RP2350 } from './rp2350';
import { AlarmCallback } from './clock/clock';
import { RPSIOCore } from './sio-core';
import { FIFO } from './utils/fifo';
import { Timer32, Timer32PeriodicAlarm, TimerMode } from './utils/timer32';

const CPUID = 0x000;

// RISC-V platform timer (mtime/mtimecmp), memory-mapped via SIO. mtime is
// shared between cores; mtimecmp/mtimecmph are core-local (RP2350 datasheet
// / hardware_regs/sio.h). The interrupt (SIO_IRQ_MTIMECMP) is asserted
// whenever mtime >= mtimecmp, and is what tud_task()'s scheduling loop (and
// other periodic bare-metal polling) relies on to wake from `wfi`.
const MTIME_CTRL = 0x1a4;
const MTIME = 0x1b0;
const MTIMEH = 0x1b4;
const MTIMECMP = 0x1b8;
const MTIMECMPH = 0x1bc;
const MTIME_CTRL_EN = 1 << 0;
const MTIME_FREQUENCY = 1_000_000; // 1 MHz tick rate (functional approximation)

// GPIO
const GPIO_IN = 0x004; // Input value for GPIO pins
const GPIO_HI_IN = 0x008; // Input value for QSPI pins

const GPIO_OUT = 0x010; // GPIO output value
const GPIO_OUT_SET = 0x018; // GPIO output value set
const GPIO_OUT_CLR = 0x020; // GPIO output value clear
const GPIO_OUT_XOR = 0x028; // GPIO output value XOR
const GPIO_OE = 0x030; // GPIO output enable
const GPIO_OE_SET = 0x038; // GPIO output enable set
const GPIO_OE_CLR = 0x040; // GPIO output enable clear
const GPIO_OE_XOR = 0x048; // GPIO output enable XOR

const GPIO_HI_OUT = 0x014; // GPIO32..47, QSPI, USB output value
const GPIO_HI_OUT_SET = 0x01c; // GPIO32..47, QSPI, USB output value set
const GPIO_HI_OUT_CLR = 0x024; // GPIO32..47, QSPI, USB output value clear
const GPIO_HI_OUT_XOR = 0x02c; // GPIO32..47, QSPI, USB output value XOR
const GPIO_HI_OE = 0x034; // GPIO32..47, QSPI, USB output enable
const GPIO_HI_OE_SET = 0x03c; // GPIO32..47, QSPI, USB output enable set
const GPIO_HI_OE_CLR = 0x044; // GPIO32..47, QSPI, USB output enable clear
const GPIO_HI_OE_XOR = 0x04c; // GPIO32..47, QSPI, USB output enable XOR

const GPIO_MASK = 0x3fffffff;

//SPINLOCK
const SPINLOCK_ST = 0x5c;
const SPINLOCK0 = 0x100;
const SPINLOCK31 = 0x17c;

/** Fires the per-core mtimecmp interrupt; a dedicated class (rather than RPSIO
 * implementing AlarmCallback itself) since there are two per-core alarms. */
class MtimecmpAlarmCallback implements AlarmCallback {
  constructor(
    private readonly rp2040: RP2350,
    private readonly sio_mtimecmp_irq: number,
    private readonly core: number
  ) {}

  fire() {
    this.rp2040.setInterruptCore(this.sio_mtimecmp_irq, true, this.core);
  }
}

export class RPSIO {
  gpioValue = 0;
  gpioOutputEnable = 0;
  gpioHiValue = 0;
  gpioHiOutputEnable = 0;
  spinLock = 0;
  readonly sioCore: [RPSIOCore, RPSIOCore];

  // mtime: shared 32-bit-approximated free-running counter (mtimeh always
  // reads 0 here — fine for realistic tick intervals within a ~4295s/1MHz
  // window). mtimecmp/mtimecmph are core-local per the datasheet.
  readonly mtimeTimer: Timer32;
  private mtimeCtrl = 0x0000000d; // reset value: DBGPAUSE_CORE1/0=1, FULLSPEED=0, EN=1
  private readonly mtimecmpAlarm: [Timer32PeriodicAlarm, Timer32PeriodicAlarm];
  private readonly mtimecmpHigh: [number, number] = [0, 0];

  constructor(
    private readonly rp2040: RP2350,
    readonly sio_proc0_irq: number,
    readonly sio_proc1_irq: number,
    readonly sio_mtimecmp_irq: number = sio_proc0_irq
  ) {
    const rxFIFO = new FIFO(8);
    const txFIFO = new FIFO(8);
    this.sioCore = [
      new RPSIOCore(rp2040, rxFIFO, txFIFO, sio_proc0_irq, sio_proc1_irq, 0, 1),
      new RPSIOCore(rp2040, txFIFO, rxFIFO, sio_proc1_irq, sio_proc0_irq, 1, 0),
    ];

    this.mtimeTimer = new Timer32('SIO_mtime', rp2040.clock, MTIME_FREQUENCY);
    this.mtimeTimer.mode = TimerMode.Increment;
    this.mtimecmpAlarm = [
      this.createMtimecmpAlarm(rp2040, sio_mtimecmp_irq, 0),
      this.createMtimecmpAlarm(rp2040, sio_mtimecmp_irq, 1),
    ];
  }

  private createMtimecmpAlarm(rp2040: RP2350, sio_mtimecmp_irq: number, core: number) {
    const alarm = new Timer32PeriodicAlarm(
      `SIO_mtimecmp_core${core}`,
      this.mtimeTimer,
      new MtimecmpAlarmCallback(rp2040, sio_mtimecmp_irq, core)
    );
    alarm.target = 0xffffffff; // matches MTIMECMP reset value
    alarm.enable = true;
    return alarm;
  }

  readUint32(offset: number, cpuCore: number): number {
    if (offset >= SPINLOCK0 && offset <= SPINLOCK31) {
      const bitIndexMask = 1 << ((offset - SPINLOCK0) / 4);
      if (this.spinLock & bitIndexMask) {
        return 0;
      } else {
        this.spinLock |= bitIndexMask;
        return bitIndexMask;
      }
    }
    switch (offset) {
      case GPIO_IN:
        return this.rp2040.gpioValues(0);
      case GPIO_HI_IN: {
        // RP2350: QSPI pins at bits 31:26, GPIO32+ at bits 25:0.
        // QSPI_SCLK=bit31, QSPI_SS=bit27, QSPI_SD0=bit28, QSPI_SD1=bit29.
        const { qspi } = this.rp2040;
        let result = 0;
        for (let qspiIndex = 0; qspiIndex < qspi.length; qspiIndex++) {
          if (qspi[qspiIndex].inputValue) {
            result |= 1 << qspiIndex;
          }
        }
        result <<= 26;
        result |= this.rp2040.gpioValues(32);
        return result;
      }
      case GPIO_OUT:
        return this.gpioValue;
      case GPIO_OE:
        return this.gpioOutputEnable;
      case GPIO_HI_OUT:
        return this.gpioHiValue;
      case GPIO_HI_OE:
        return this.gpioHiOutputEnable;
      case GPIO_OUT_SET:
      case GPIO_OUT_CLR:
      case GPIO_OUT_XOR:
      case GPIO_OE_SET:
      case GPIO_OE_CLR:
      case GPIO_OE_XOR:
      case GPIO_HI_OUT_SET:
      case GPIO_HI_OUT_CLR:
      case GPIO_HI_OUT_XOR:
      case GPIO_HI_OE_SET:
      case GPIO_HI_OE_CLR:
      case GPIO_HI_OE_XOR:
        return 0; // TODO verify with silicone
      case CPUID:
        return cpuCore;
      case SPINLOCK_ST:
        return this.spinLock;
      case MTIME_CTRL:
        return this.mtimeCtrl;
      case MTIME:
        return this.mtimeTimer.counter >>> 0;
      case MTIMEH:
        return 0; // approximation: mtime never wraps past 32 bits in practice
      case MTIMECMP:
        return this.mtimecmpAlarm[cpuCore].target >>> 0;
      case MTIMECMPH:
        return this.mtimecmpHigh[cpuCore];
    }
    // Divider, Interpolator, FIFO get handled per core in sio-core
    return this.sioCore[cpuCore].readUint32(offset);
  }

  writeUint32(offset: number, value: number, cpuCore: number) {
    if (offset >= SPINLOCK0 && offset <= SPINLOCK31) {
      const bitIndexMask = ~(1 << ((offset - SPINLOCK0) / 4));
      this.spinLock &= bitIndexMask;
      return;
    }
    const prevGpioValue = this.gpioValue;
    const prevGpioOutputEnable = this.gpioOutputEnable;
    const prevGpioHiValue = this.gpioHiValue;
    const prevGpioHiOutputEnable = this.gpioHiOutputEnable;
    switch (offset) {
      case GPIO_OUT:
        this.gpioValue = value & GPIO_MASK;
        break;
      case GPIO_OUT_SET:
        this.gpioValue |= value & GPIO_MASK;
        break;
      case GPIO_OUT_CLR:
        this.gpioValue &= ~value;
        break;
      case GPIO_OUT_XOR:
        this.gpioValue ^= value & GPIO_MASK;
        break;
      case GPIO_OE:
        this.gpioOutputEnable = value & GPIO_MASK;
        break;
      case GPIO_OE_SET:
        this.gpioOutputEnable |= value & GPIO_MASK;
        break;
      case GPIO_OE_CLR:
        this.gpioOutputEnable &= ~value;
        break;
      case GPIO_OE_XOR:
        this.gpioOutputEnable ^= value & GPIO_MASK;
        break;
      case GPIO_HI_OUT:
        this.gpioHiValue = value & GPIO_MASK;
        break;
      case GPIO_HI_OUT_SET:
        this.gpioHiValue |= value & GPIO_MASK;
        break;
      case GPIO_HI_OUT_CLR:
        this.gpioHiValue &= ~value;
        break;
      case GPIO_HI_OUT_XOR:
        this.gpioHiValue ^= value & GPIO_MASK;
        break;
      case GPIO_HI_OE:
        this.gpioHiOutputEnable = value & GPIO_MASK;
        break;
      case GPIO_HI_OE_SET:
        this.gpioHiOutputEnable |= value & GPIO_MASK;
        break;
      case GPIO_HI_OE_CLR:
        this.gpioHiOutputEnable &= ~value;
        break;
      case GPIO_HI_OE_XOR:
        this.gpioHiOutputEnable ^= value & GPIO_MASK;
        break;
      case MTIME_CTRL:
        this.mtimeCtrl = value;
        this.mtimeTimer.enable = !!(value & MTIME_CTRL_EN);
        break;
      case MTIME:
        this.mtimeTimer.set(value >>> 0);
        break;
      case MTIMEH:
        break; // approximation: high word not tracked
      case MTIMECMPH:
        this.mtimecmpHigh[cpuCore] = value >>> 0;
        break;
      case MTIMECMP:
        // Writing mtimecmp clears the (level-sensitive) interrupt condition
        // until mtime reaches the new target — matches real hardware, and is
        // how firmware acknowledges/reschedules the tick after each fire.
        this.rp2040.setInterruptCore(this.sio_mtimecmp_irq, false, cpuCore);
        this.mtimecmpAlarm[cpuCore].target = value >>> 0;
        break;
      default:
        // Divider, Interpolator, FIFO get handled per core in sio-core
        this.sioCore[cpuCore].writeUint32(offset, value);
    }

    let pinsToUpdate =
      (this.gpioValue ^ prevGpioValue) | (this.gpioOutputEnable ^ prevGpioOutputEnable);
    const { gpio } = this.rp2040;
    if (pinsToUpdate) {
      for (let gpioIndex = 0; gpioIndex < 32; gpioIndex++) {
        if (pinsToUpdate & (1 << gpioIndex)) {
          gpio[gpioIndex].checkForUpdates();
        }
      }
    }

    pinsToUpdate =
      (this.gpioHiValue ^ prevGpioHiValue) | (this.gpioHiOutputEnable ^ prevGpioHiOutputEnable);
    if (pinsToUpdate) {
      for (let gpioIndex = 32; gpioIndex < gpio.length; gpioIndex++) {
        if (pinsToUpdate & (1 << (gpioIndex - 32))) {
          gpio[gpioIndex].checkForUpdates();
        }
      }
    }
    //TODO qspi pins
  }

  getPinValue(index: number) {
    if (index < 32) {
      return !!(this.gpioValue & (1 << index));
    } else if (index < 48) {
      return !!(this.gpioHiValue & (1 << (index - 32)));
    }
    //TODO qspi pins
    return false;
  }

  getOutputEnabled(index: number) {
    if (index < 32) {
      return !!(this.gpioOutputEnable & (1 << index));
    } else if (index < 48) {
      return !!(this.gpioHiOutputEnable & (1 << (index - 32)));
    }
    //TODO qspi pins
    return false;
  }
}
