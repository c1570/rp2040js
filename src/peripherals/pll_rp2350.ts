import { BasePeripheral, Peripheral } from './peripheral';

const FREF = 12000000;

export class RP2350PLL extends BasePeripheral implements Peripheral {
  reg = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, (1<<12) + (1<<16), 0];
  foutpostdiv = 1;

  readUint32(offset: number) {
    if(offset === 0x0) return this.reg[0] | (1 << 31); // PLL is always locked
    if(offset <= 0xc) return this.reg[offset];
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    let handled = false;
    switch(offset) {
      case 0x00:
      case 0x08:
      case 0x0c:
        this.reg[offset] = value;
        handled = true;
        break;
    }
    const refdiv = this.reg[0x0] & 0x1f;
    const fbdiv = this.reg[0x8];
    const postdiv2 = (this.reg[0xc] >> 12) & 7;
    const postdiv1 = (this.reg[0xc] >> 16) & 7;
    this.foutpostdiv = (FREF / refdiv) * fbdiv / (postdiv1 * postdiv2);
    if(handled) {
      console.log(`PLL write ${value} to 0x${offset.toString(16)}, foutpostdiv = ${this.foutpostdiv}`);
      return;
    }
    return super.writeUint32(offset, value);
  }
}
