import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const CHIP_RESET = 0x08;

/**
 * Minimal VREG_AND_CHIP_RESET peripheral for RP2040.
 *
 * The bootrom checks CHIP_RESET.PSM_RESTART_FLAG (bit 24) at startup — if set,
 * it enters rescue mode and halts. UnimplementedPeripheral returned 0xffffffff
 * (all bits set), causing the bootrom to think a rescue is in progress.
 * Here we return 0 for all reads, matching the normal (non-rescue) boot state.
 */
export class RP2040VregAndChipReset<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  chipReset = 0;

  readUint32(offset: number) {
    switch (offset) {
      case CHIP_RESET:
        return this.chipReset;
      default:
        return super.readUint32(offset);
    }
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case CHIP_RESET:
        // PSM_RESTART_FLAG (bit 24) is write-1-to-clear
        this.chipReset &= ~(value & (1 << 24));
        break;
      default:
        super.writeUint32(offset, value);
    }
  }
}
