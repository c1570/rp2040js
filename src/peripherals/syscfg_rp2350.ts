import { IRPChip } from '../rpchip';
import { RP2350 } from '../rp2350';
import { BasePeripheral, Peripheral } from './peripheral';

export class RP2350SysCfg<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  readUint32(offset: number) {
    if (offset === 0) return 0;
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    super.writeUint32(offset, value);
  }
}
