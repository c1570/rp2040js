import { IRPChip } from '../rpchip';

const ATOMIC_NORMAL = 0;
const ATOMIC_XOR = 1;
const ATOMIC_SET = 2;
const ATOMIC_CLEAR = 3;

export function atomicUpdate(currentValue: number, atomicType: number, newValue: number) {
  switch (atomicType) {
    case ATOMIC_XOR:
      return currentValue ^ newValue;
    case ATOMIC_SET:
      return currentValue | newValue;
    case ATOMIC_CLEAR:
      return currentValue & ~newValue;
    default:
      console.warn('Atomic update called with invalid writeType', atomicType);
      return newValue;
  }
}

export interface Peripheral {
  readUint32(offset: number): number;
  readUint32ViaCore(offset: number, core: number): number;
  writeUint32(offset: number, value: number): void;
  writeUint32ViaCore(offset: number, value: number, core: number): void;
  writeUint32Atomic(offset: number, value: number, atomicType: number): void;
  /**
   * True for peripherals that are plain byte-addressable memory (e.g.
   * BOOTRAM scratch RAM), as opposed to normal APB registers. Byte/halfword
   * writes to such peripherals must be a read-modify-write of the aligned
   * word rather than the usual replicate-across-the-word + atomic-write
   * behavior real APB peripheral registers get (which would clobber
   * neighboring bytes).
   *
   * A method rather than a property so cts2c resolves it via its well-tested
   * method-vtable dispatch; interface property signatures are a less-tested path.
   */
  byteAddressable(): boolean;
}

export class BasePeripheral<ChipType extends IRPChip = IRPChip> implements Peripheral {
  protected rawWriteValue = 0;

  constructor(protected rp2040: ChipType, readonly name: string) {}

  byteAddressable() {
    return false;
  }

  readUint32(offset: number) {
    this.warn(`Unimplemented peripheral read from ${offset.toString(16)}`);
    if (offset > 0x1000) {
      this.warn('Unimplemented read from peripheral in the atomic operation region');
    }
    return 0xffffffff;
  }

  readUint32ViaCore(offset: number, core: number) {
    this.warn(`Unimplemented peripheral readvia ${core} from 0x${offset.toString(16)}`);
    return 0xffffffff;
  }

  writeUint32(offset: number, value: number) {
    this.warn(`Unimplemented peripheral write to 0x${offset.toString(16)}: ${value}`);
  }

  writeUint32ViaCore(offset: number, value: number, core: number) {
    this.warn(`Unimplemented peripheral write via ${core} to 0x${offset.toString(16)}: ${value}`);
  }

  writeUint32Atomic(offset: number, value: number, atomicType: number) {
    this.rawWriteValue = value;
    const newValue =
      atomicType != ATOMIC_NORMAL
        ? atomicUpdate(this.readUint32(offset), atomicType, value)
        : value;
    this.writeUint32(offset, newValue);
  }

  debug(msg: string) {
    this.rp2040.logger.debug(this.name, msg);
  }

  info(msg: string) {
    this.rp2040.logger.info(this.name, msg);
  }

  warn(msg: string) {
    this.rp2040.logger.warn(this.name, msg);
  }

  error(msg: string) {
    this.rp2040.logger.error(this.name, msg);
  }
}

export class UnimplementedPeripheral extends BasePeripheral {}
