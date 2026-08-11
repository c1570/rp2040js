import { IRPChip } from '../rpchip';
import { RP2040 } from '../rp2040';
import { BasePeripheral, Peripheral } from './peripheral';

const PROC0_NMI_MASK = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const PROC1_NMI_MASK = 4;

export class RP2040SysCfg<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  readUint32(offset: number) {
    switch (offset) {
      case PROC0_NMI_MASK:
        return (this.rpchip as unknown as RP2040).core0.interruptNMIMask;
      case PROC1_NMI_MASK:
        return (this.rpchip as unknown as RP2040).core1.interruptNMIMask;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case PROC0_NMI_MASK:
        (this.rpchip as unknown as RP2040).core0.interruptNMIMask = value;
        break;
      case PROC1_NMI_MASK:
        (this.rpchip as unknown as RP2040).core1.interruptNMIMask = value;
        break;

      default:
        super.writeUint32(offset, value);
    }
  }
}
