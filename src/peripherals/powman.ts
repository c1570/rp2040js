import { BasePeripheral, Peripheral } from './peripheral';

export class RPPOWMAN extends BasePeripheral implements Peripheral {
  readUint32(offset: number) {
    if(offset === 0xc) return 0;
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    super.writeUint32(offset, value);
  }
}
