import { BasePeripheral, Peripheral } from './peripheral';

const CHIP_ID = 0;
const PACKAGE_SEL = 0x4;
const PLATFORM = 0x8;
const GITREF_RP2350 = 0x14;

export class RP2350SysInfo extends BasePeripheral implements Peripheral {
  readUint32(offset: number) {
    // All the values here were verified against the silicon
    switch (offset) {
      case CHIP_ID:
        return 0x20004927;

      case PACKAGE_SEL:
        return 0x00000001; // QFN60

      case PLATFORM:
        return 0x00000000;

      case GITREF_RP2350:
        return 0x5a09d5a2;
    }
    return super.readUint32(offset);
  }
}
