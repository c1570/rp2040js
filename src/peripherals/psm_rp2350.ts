import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const FRCE_ON = 0x00;
const FRCE_OFF = 0x04;
const WDSEL = 0x08;
const DONE = 0x0c;

const PSM_BITS_MASK = 0x0001ffff;

/**
 * RP2350 PSM (Power State Machine) peripheral.
 * Reference: RP2350 datasheet §7.4, base 0x40018000.
 */
export class RP2350PSM<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private frceOn = 0;
  private frceOff = 0;
  private wdsel = 0;

  readUint32(offset: number) {
    switch (offset) {
      case FRCE_ON:
        return this.frceOn;
      case FRCE_OFF:
        return this.frceOff;
      case WDSEL:
        return this.wdsel;
      case DONE:
        return (PSM_BITS_MASK & ~this.frceOff) | (this.frceOn & this.frceOff);
    }
    return 0;
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case FRCE_ON:
        this.frceOn = value & PSM_BITS_MASK;
        break;
      case FRCE_OFF:
        this.frceOff = value & PSM_BITS_MASK;
        break;
      case WDSEL:
        this.wdsel = value & PSM_BITS_MASK;
        break;
    }
  }
}
