import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const OTP_ROWS = 4096;

/**
 * RP2350 OTP control/interface registers at OTP_BASE (0x40120000).
 * Modelled as store-and-readback. The fuse array (shared with the
 * OTP_DATA read window) is a separate Uint16Array seeded blank.
 * RP2350 datasheet §4.5
 */
export class RP2350OTP<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  readonly fuse = new Uint16Array(OTP_ROWS);
  private readonly regs = new Uint32Array(0x200 >> 2);

  // Explicit pass-through constructor: cts2c only synthesizes a `_new()` for a class
  // with its own declared constructor — a subclass relying on the parent's implicit
  // constructor would get no allocator at all.
  constructor(rpchip: ChipType, name: string) {
    super(rpchip, name);
  }

  readUint32(offset: number) {
    if (offset < this.regs.length * 4) return this.regs[offset >> 2];
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset < this.regs.length * 4) {
      this.regs[offset >> 2] = value >>> 0;
      return;
    }
    super.writeUint32(offset, value);
  }
}

/**
 * RP2350 OTP_DATA read window (0x40130000+). Read-only: row N is at
 * byte offset N*4 and returns the 16-bit fuse value from the shared
 * fuse array. Writes are ignored.
 */
export class RP2350OTPData<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  constructor(rpchip: ChipType, name: string, private readonly otp: RP2350OTP) {
    super(rpchip, name);
  }

  readUint32(offset: number) {
    const row = offset >> 2;
    if (row < this.otp.fuse.length) return this.otp.fuse[row];
    return super.readUint32(offset);
  }

  writeUint32() {
    // The guarded data window is read-only.
  }
}

// Re-export to satisfy existing import name.
export { RP2350OTPData as RP2350OTPDataLegacy };
