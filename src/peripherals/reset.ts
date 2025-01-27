import { RP2350 } from '../rp2350';
import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const RESET = 0x0; //Reset control.
const WDSEL = 0x4; //Watchdog select.
const RESET_DONE = 0x8; //Reset Done

export class RPReset extends BasePeripheral implements Peripheral {
  private reset: number = 0;
  private wdsel: number = 0;
  private reset_done: number = 0x1ffffff;
  private reset_mask: number = 0x1ffffff;

  constructor(protected rp2040: IRPChip, readonly name: string) {
    super(rp2040, name);
    if(rp2040 instanceof RP2350) {
      this.reset_done = this.reset_mask = 0x1fffffff;
    }
  }

  readUint32(offset: number) {
    switch (offset) {
      case RESET:
        return this.reset;
      case WDSEL:
        return this.wdsel;
      case RESET_DONE:
        return this.reset_done;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case RESET:
        this.reset = value & this.reset_mask;
        break;
      case WDSEL:
        this.wdsel = value & this.reset_mask;
        break;
      default:
        super.writeUint32(offset, value);
        break;
    }
  }
}
