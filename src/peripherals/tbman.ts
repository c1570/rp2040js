import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';
const PLATFORM = 0;
const ASIC = 1;

export class RPTBMAN<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  readUint32(offset: number) {
    switch (offset) {
      case PLATFORM:
        return ASIC;
      default:
        return super.readUint32(offset);
    }
  }
}
