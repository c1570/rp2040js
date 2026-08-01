import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const RNG_ISR_OFFSET = 0x104;
const RNG_ICR_OFFSET = 0x108;
const TRNG_CONFIG_OFFSET = 0x10c;
const TRNG_VALID_OFFSET = 0x110;
const EHR_DATA0_OFFSET = 0x114;
const EHR_DATA5_OFFSET = 0x128;
const RND_SOURCE_ENABLE_OFFSET = 0x12c;
const TRNG_SW_RESET_OFFSET = 0x140;

const SEED = 0x2350c0de;

/**
 * RP2350 TRNG (True Random Number Generator) peripheral.
 * Models the Synopsys TRNG with a deterministic xorshift32 PRNG.
 * Enabling the source (RND_SOURCE_ENABLE) fills the 192-bit EHR and
 * raises EHR_VALID; reading EHR_DATA5 consumes the result and, while
 * enabled, collects the next one. TRNG_SW_RESET is a write-only strobe
 * that reads as 0.
 * See RP2350 datasheet §12.12
 */
export class RP2350TRNG<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private state = SEED >>> 0;
  private readonly ehr = new Uint32Array(6);
  private valid = false;
  private enabled = false;
  private regs: { [offset: number]: number } = {};

  private nextWord(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  private collect() {
    for (let i = 0; i < 6; i++) this.ehr[i] = this.nextWord();
    this.valid = true;
  }

  readUint32(offset: number) {
    switch (offset) {
      case RNG_ISR_OFFSET:
      case TRNG_VALID_OFFSET:
        return this.valid ? 1 : 0;
      case RND_SOURCE_ENABLE_OFFSET:
        return this.enabled ? 1 : 0;
      default:
        break;
    }
    if (offset >= EHR_DATA0_OFFSET && offset <= EHR_DATA5_OFFSET) {
      const value = this.ehr[(offset - EHR_DATA0_OFFSET) >>> 2];
      if (offset === EHR_DATA5_OFFSET) {
        this.valid = false;
        if (this.enabled) this.collect();
      }
      return value;
    }
    if (offset === TRNG_SW_RESET_OFFSET) {
      // Write-only strobe: reads as 0.
      return 0;
    }
    return this.regs[offset] ?? 0;
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case RND_SOURCE_ENABLE_OFFSET:
        this.enabled = !!(value & 1);
        if (this.enabled && !this.valid) this.collect();
        return;
      case TRNG_SW_RESET_OFFSET:
        if (value & 1) {
          this.state = SEED >>> 0;
          this.ehr.fill(0);
          this.valid = false;
          this.enabled = false;
        }
        return;
      case RNG_ICR_OFFSET:
        return; // interrupt clear — no-op
      default:
        break;
    }
    this.regs[offset] = value >>> 0;
  }
}
