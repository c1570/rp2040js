import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const GPIO_CTRL_LAST = 0x17c;
const INTR0 = 0x230;
const PROC0_INTE0 = 0x248;
const PROC0_INTF0 = 0x260;
const PROC0_INTS0 = 0x278;
const PROC0_INTS5 = 0x280;

export class RP2350IO<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  constructor(rp2040: ChipType, name: string) {
    super(rp2040, name);
  }

  readUint32(offset: number) {
    if (offset <= GPIO_CTRL_LAST) {
      // Inlined (not a getPinFromOffset() helper): cts2c would heap-allocate the
      // returned object per call, and this is a hot path (every GPIO register access).
      const gpio = this.rp2040.gpio[offset >>> 3];
      const isCtrl = !!(offset & 0x4);
      return isCtrl ? gpio.ctrl : gpio.status;
    }
    if (offset >= INTR0 && offset <= PROC0_INTS5) {
      const startIndex = ((offset - INTR0) % 0x18) * 8;
      const register = (offset % 0x18) * 0x18;
      const { gpio } = this.rp2040;
      let result = 0;
      for (let index = 7; index >= 0; index--) {
        const pin = gpio[index + startIndex];
        if (!pin) {
          continue;
        }
        result <<= 4;
        switch (register) {
          case INTR0:
            result |= pin.irqStatus;
            break;
          case PROC0_INTE0:
            result |= pin.irqEnableMask;
            break;
          case PROC0_INTF0:
            result |= pin.irqForceMask;
            break;
          case PROC0_INTS0:
            result |= (pin.irqStatus & pin.irqEnableMask) | pin.irqForceMask;
            break;
        }
      }
      return result;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset <= GPIO_CTRL_LAST) {
      const gpio = this.rp2040.gpio[offset >>> 3];
      const isCtrl = !!(offset & 0x4);
      if (isCtrl) {
        gpio.ctrl = value;
        gpio.checkForUpdates();
      }
      return;
    }
    if (offset >= INTR0 && offset <= PROC0_INTS5) {
      const startIndex = ((offset - INTR0) % 0x18) * 8;
      const register = (offset % 0x18) * 0x18;
      const { gpio } = this.rp2040;
      for (let index = 0; index < 8; index++) {
        const pin = gpio[index + startIndex];
        if (!pin) {
          continue;
        }
        const pinValue = (value >> (index * 4)) & 0xf;
        const pinRawWriteValue = (this.rawWriteValue >> (index * 4)) & 0xf;
        switch (register) {
          case INTR0:
            pin.updateIRQValue(pinRawWriteValue);
            break;
          case PROC0_INTE0:
            if (pin.irqEnableMask !== pinValue) {
              pin.irqEnableMask = pinValue;
              this.rp2040.updateIOInterrupt();
            }
            break;
          case PROC0_INTF0:
            if (pin.irqForceMask !== pinValue) {
              pin.irqForceMask = pinValue;
              this.rp2040.updateIOInterrupt();
            }
            break;
        }
      }
      return;
    }

    super.writeUint32(offset, value);
  }
}
