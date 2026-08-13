import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const SSI_CTRLR0 = 0x00000000;
const SSI_SSIENR = 0x00000008;
const SSI_SER = 0x00000010;
const SSI_BAUDR = 0x00000014;
const SSI_TXFLR = 0x00000020;
const SSI_RXFLR = 0x00000024;
const SSI_SR = 0x00000028;
const SSI_DR0 = 0x00000060;
const SSI_IDR = 0x00000058;
const SSI_VERSION_ID = 0x0000005c;

const SSI_SR_TFNF_BITS = 0x00000002;
const SSI_SR_TFE_BITS = 0x00000004;
const SSI_SR_RFNE_BITS = 0x00000008;

const CMD_READ_DATA = 0x03;
const CMD_READ_SFDP = 0x5a;
const CMD_READ_STATUS = 0x05;
const CMD_JEDEC_ID = 0x9f;

enum SpiPhase {
  Idle,
  Addr,
  Dummy,
  Data,
  Status,
  Jedec,
}

/**
 * RP2040 SSI (SPI Slave Interface) with minimal SPI flash emulation.
 *
 * Models the SSI as a synchronous full-duplex SPI master: every byte written
 * to DR0 immediately produces a response byte in the RX FIFO. The response
 * depends on the SPI flash protocol phase (command → address → data).
 *
 * This is sufficient for the bootrom's flash_read_data() path.
 * Programming/erase commands are accepted but treated as no-ops.
 */
export class RPSSI<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  // Simple register file for ctrlr0/ssienr/ser/baudr etc.
  private regs = new Uint32Array(0x100);

  // SPI flash protocol state
  private phase = SpiPhase.Idle;
  private flashCmd = 0;
  private flashAddr = 0;
  private addrBytesRemaining = 0;

  // RX FIFO: response bytes awaiting read by firmware.
  // Hardware FIFO depth is 16; modeled as a circular buffer.
  private readonly rxFifo = new Uint8Array(16);
  private rxFifoHead = 0;
  private rxFifoTail = 0;
  private rxFifoCount = 0;

  private resetSpiState() {
    this.phase = SpiPhase.Idle;
    this.flashCmd = 0;
    this.flashAddr = 0;
    this.addrBytesRemaining = 0;
    this.rxFifoHead = 0;
    this.rxFifoTail = 0;
    this.rxFifoCount = 0;
  }

  private rxFifoPush(value: number) {
    if (this.rxFifoCount < 16) {
      this.rxFifo[this.rxFifoTail] = value & 0xff;
      this.rxFifoTail = (this.rxFifoTail + 1) & 15;
      this.rxFifoCount++;
    }
  }

  private rxFifoShift(): number {
    if (this.rxFifoCount === 0) return 0;
    const value = this.rxFifo[this.rxFifoHead];
    this.rxFifoHead = (this.rxFifoHead + 1) & 15;
    this.rxFifoCount--;
    return value;
  }

  private processSpiByte(txByte: number): number {
    switch (this.phase) {
      case SpiPhase.Idle: {
        // Command byte — start a new transaction.
        this.flashCmd = txByte;
        switch (txByte) {
          case CMD_READ_DATA:
          case CMD_READ_SFDP:
            this.phase = SpiPhase.Addr;
            this.flashAddr = 0;
            this.addrBytesRemaining = 3;
            break;
          case CMD_READ_STATUS:
            this.phase = SpiPhase.Status;
            break;
          case CMD_JEDEC_ID:
            this.phase = SpiPhase.Jedec;
            this.addrBytesRemaining = 0;
            break;
          default:
            // Unknown / programming command — stay idle.
            break;
        }
        return 0xff;
      }
      case SpiPhase.Addr: {
        this.flashAddr = ((this.flashAddr << 8) | (txByte & 0xff)) >>> 0;
        if (--this.addrBytesRemaining === 0) {
          // READ_SFDP has an extra dummy byte before data.
          this.phase = this.flashCmd === CMD_READ_SFDP ? SpiPhase.Dummy : SpiPhase.Data;
        }
        return 0xff;
      }
      case SpiPhase.Dummy:
        this.phase = SpiPhase.Data;
        return 0xff;
      case SpiPhase.Data: {
        const flash = this.rpchip.flash;
        const byte = this.flashAddr < 0x1000000 ? flash[this.flashAddr] : 0xff;
        this.flashAddr = (this.flashAddr + 1) >>> 0;
        return byte;
      }
      case SpiPhase.Status:
        return 0; // Not busy, no write pending.
      case SpiPhase.Jedec: {
        // W25X10CL: manufacturer 0xef, device 0x12, 0x11
        const idx = this.addrBytesRemaining++;
        if (idx === 0) return 0xef;
        if (idx === 1) return 0x12;
        if (idx === 2) return 0x11;
        return 0xff;
      }
      default:
        return 0xff;
    }
  }

  readUint32(offset: number) {
    switch (offset) {
      case SSI_TXFLR:
        return 0; // Transfers complete synchronously — TX FIFO always empty.
      case SSI_RXFLR:
        return this.rxFifoCount;
      case SSI_SR:
        return (
          (SSI_SR_TFE_BITS | SSI_SR_TFNF_BITS | (this.rxFifoCount > 0 ? SSI_SR_RFNE_BITS : 0)) >>> 0
        );
      case SSI_DR0:
        return this.rxFifoShift();
      case SSI_IDR:
        return 0x51535049;
      case SSI_VERSION_ID:
        return 0x3430312a;
      default:
        if (offset < this.regs.length * 4) {
          return this.regs[offset / 4];
        }
        return super.readUint32(offset);
    }
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case SSI_SSIENR:
        // Disabling SSI resets the SPI state and FIFOs.
        if ((value & 1) === 0) {
          this.resetSpiState();
        }
        if (offset / 4 < this.regs.length) {
          this.regs[offset / 4] = value & 1;
        }
        break;
      case SSI_DR0: {
        const txByte = value & 0xff;
        const rxByte = this.processSpiByte(txByte);
        this.rxFifoPush(rxByte);
        break;
      }
      default:
        if (offset / 4 < this.regs.length) {
          this.regs[offset / 4] = value >>> 0;
        } else {
          super.writeUint32(offset, value);
        }
        break;
    }
  }
}
