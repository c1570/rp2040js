import { IRPChip } from './rpchip';
import { Core } from './core';
import { RPSIOCore } from './sio-core';

const CPUID = 0x000;

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

export class RPSIO {
  gpioValue = 0;
  gpioOutputEnable = 0;
  gpioHiValue = 0;
  gpioHiOutputEnable = 0;
  spinLock = 0;
  readonly core0;
  readonly core1;

  constructor(private readonly rp2040: IRPChip, readonly sio_proc0_irq: number, readonly sio_proc1_irq: number) {
    const cores = RPSIOCore.create2Cores(rp2040, sio_proc0_irq, sio_proc1_irq);
    this.core0 = cores[0];
    this.core1 = cores[1];
  }

  readUint32(offset: number, core: Core) : number {
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
        switch (core) {
          case Core.Core0:
            return 0;
          case Core.Core1:
            return 1;
        }
        break;
      case SPINLOCK_ST:
        return this.spinLock;
    }
    // Divider, Interpolator, FIFO get handled per core in sio-core
    switch (core) {
      case Core.Core0:
        return this.core0.readUint32(offset);
      case Core.Core1:
        return this.core1.readUint32(offset);
    }
  }

  writeUint32(offset: number, value: number, core: Core) {
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
      default:
        // Divider, Interpolator, FIFO get handled per core in sio-core
        switch (core) {
          case Core.Core0:
            this.core0.writeUint32(offset, value);
            break;
          case Core.Core1:
            this.core1.writeUint32(offset, value);
            break;
        }
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
