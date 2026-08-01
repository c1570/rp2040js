import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const QMI_DIRECT_CSR = 0x00;
const QMI_DIRECT_TX = 0x04;
const QMI_DIRECT_RX = 0x08;

const DIRECT_CSR_RESET = 0x01800000;
const DIRECT_CSR_BUSY = 1 << 1;
const DIRECT_CSR_TXEMPTY = 1 << 11;
const DIRECT_CSR_TXFULL = 1 << 10;
const DIRECT_CSR_RXEMPTY = 1 << 16;
const DIRECT_CSR_RXFULL = 1 << 17;
const DIRECT_CSR_EN = 1 << 0;

/**
 * RP2350 QSPI Memory Interface (QMI).
 * Reference: RP2350 datasheet §12.14.
 * Models the direct-mode CSR/TX/RX FIFOs as always-empty/never-busy
 * so the bootrom's polling loops complete. The memory-mapped XIP
 * window (0x10000000+) is handled by the chip's flash array directly.
 */
export class RPXIPQMI<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private directCsr = DIRECT_CSR_RESET;
  private directCsrEn = false;

  readUint32(offset: number) {
    if (offset === QMI_DIRECT_CSR) {
      // BUSY is never set (we complete transfers synchronously).
      // FIFO status bits report empty (both FIFOs at reset).
      return (
        (this.directCsr |
          (this.directCsrEn ? DIRECT_CSR_EN : 0) |
          DIRECT_CSR_TXEMPTY |
          DIRECT_CSR_RXEMPTY) >>>
        0
      );
    }
    if (offset === QMI_DIRECT_RX) {
      // RX FIFO is empty — return 0 (undefined on real h/w).
      return 0;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset === QMI_DIRECT_CSR) {
      this.directCsr = value & ~DIRECT_CSR_BUSY;
      this.directCsrEn = !!(value & DIRECT_CSR_EN);
      return;
    }
    if (offset === QMI_DIRECT_TX) {
      // TX FIFO push — accept and discard (transfers complete synchronously).
      return;
    }
    super.writeUint32(offset, value);
  }
}

/** Legacy XIP peripheral (kept for any existing imports). */
export class RPXIP<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  protected regs = new Uint32Array(1024);

  readUint32(offset: number) {
    super.readUint32(offset);
    return this.regs[offset];
  }

  writeUint32(offset: number, value: number) {
    super.writeUint32(offset, value);
    this.regs[offset] = value;
  }
}
