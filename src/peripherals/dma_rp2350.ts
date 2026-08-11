import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';
import { AlarmCallback, IAlarm } from '../clock/clock';

export enum DREQChannel {
  DREQ_PIO0_TX0,
  DREQ_PIO0_TX1,
  DREQ_PIO0_TX2,
  DREQ_PIO0_TX3,
  DREQ_PIO0_RX0,
  DREQ_PIO0_RX1,
  DREQ_PIO0_RX2,
  DREQ_PIO0_RX3,
  DREQ_PIO1_TX0,
  DREQ_PIO1_TX1,
  DREQ_PIO1_TX2,
  DREQ_PIO1_TX3,
  DREQ_PIO1_RX0,
  DREQ_PIO1_RX1,
  DREQ_PIO1_RX2,
  DREQ_PIO1_RX3,
  DREQ_PIO2_TX0,
  DREQ_PIO2_TX1,
  DREQ_PIO2_TX2,
  DREQ_PIO2_TX3,
  DREQ_PIO2_RX0,
  DREQ_PIO2_RX1,
  DREQ_PIO2_RX2,
  DREQ_PIO2_RX3,
  DREQ_SPI0_TX,
  DREQ_SPI0_RX,
  DREQ_SPI1_TX,
  DREQ_SPI1_RX,
  DREQ_UART0_TX,
  DREQ_UART0_RX,
  DREQ_UART1_TX,
  DREQ_UART1_RX,
  DREQ_PWM_WRAP0,
  DREQ_PWM_WRAP1,
  DREQ_PWM_WRAP2,
  DREQ_PWM_WRAP3,
  DREQ_PWM_WRAP4,
  DREQ_PWM_WRAP5,
  DREQ_PWM_WRAP6,
  DREQ_PWM_WRAP7,
  DREQ_PWM_WRAP8,
  DREQ_PWM_WRAP9,
  DREQ_PWM_WRAP10,
  DREQ_PWM_WRAP11,
  DREQ_I2C0_TX,
  DREQ_I2C0_RX,
  DREQ_I2C1_TX,
  DREQ_I2C1_RX,
  DREQ_ADC,
  DREQ_XIP_STREAM,
  DREQ_XIP_QMITX,
  DREQ_XIP_QMIRX,
  DREQ_HSTX,
  DREQ_CORESIGHT,
  DREQ_SHA256,
  DREQ_MAX,
}

enum TREQ {
  Timer0 = 0x3b,
  Timer1 = 0x3c,
  Timer2 = 0x3d,
  Timer3 = 0x3e,
  Permanent = 0x3f,
}

const CHANNEL_COUNT = 16;
const REGISTERS_SIZE_PER_CHANNEL = 0x40;
const DEBUG_REGISTER_START = 0x800;

// Per-channel registers
const CHn_READ_ADDR = 0x000; // DMA Channel n Read Address pointer
const CHn_WRITE_ADDR = 0x004; // DMA Channel n Write Address pointer
const CHn_TRANS_COUNT = 0x008; // DMA Channel n Transfer Count
const CHn_CTRL_TRIG = 0x00c; // DMA Channel n Control and Status
const CHn_AL1_CTRL = 0x010; // Alias for channel n CTRL register
const CHn_AL1_READ_ADDR = 0x014; // Alias for channel n READ_ADDR register
const CHn_AL1_WRITE_ADDR = 0x018; // Alias for channel n WRITE_ADDR register
const CHn_AL1_TRANS_COUNT_TRIG = 0x01c; // Alias for channel n TRANS_COUNT register
const CHn_AL2_CTRL = 0x020; // Alias for channel n CTRL register
const CHn_AL2_TRANS_COUNT = 0x024; // Alias for channel n TRANS_COUNT register
const CHn_AL2_READ_ADDR = 0x028; // Alias for channel n READ_ADDR register
const CHn_AL2_WRITE_ADDR_TRIG = 0x02c; // Alias for channel n WRITE_ADDR register
const CHn_AL3_CTRL = 0x030; // Alias for channel n CTRL register
const CHn_AL3_WRITE_ADDR = 0x034; // Alias for channel n WRITE_ADDR register
const CHn_AL3_TRANS_COUNT = 0x038; // Alias for channel n TRANS_COUNT register
const CHn_AL3_READ_ADDR_TRIG = 0x03c; // Alias for channel n READ_ADDR register
const CHn_DBG_CTDREQ = 0x800;
const CHn_DBG_TCR = 0x804;

// General DMA registers
const INTR = 0x400; // Interrupt Status (raw)
const INTE0 = 0x404; // Interrupt Enables for IRQ 0
const INTF0 = 0x408; // Force Interrupts
const INTS0 = 0x40c; // Interrupt Status for IRQ 0
const INTE1 = 0x414; // Interrupt Enables for IRQ 1
const INTF1 = 0x418; // Force Interrupts for IRQ 1
const INTS1 = 0x41c; // Interrupt Status (masked) for IRQ 1
const INTE2 = 0x424; // Interrupt Enables for IRQ 2
const INTF2 = 0x428; // Force Interrupts for IRQ 2
const INTS2 = 0x42c; // Interrupt Status (masked) for IRQ 2
const INTE3 = 0x434; // Interrupt Enables for IRQ 3
const INTF3 = 0x438; // Force Interrupts for IRQ 3
const INTS3 = 0x43c; // Interrupt Status (masked) for IRQ 3
const TIMER0 = 0x440; // Pacing (X/Y) Fractional Timer
const TIMER1 = 0x444; // Pacing (X/Y) Fractional Timer
const TIMER2 = 0x448; // Pacing (X/Y) Fractional Timer
const TIMER3 = 0x44c; // Pacing (X/Y) Fractional Timer
const MULTI_CHAN_TRIGGER = 0x450; // Trigger one or more channels simultaneously
const SNIFF_CTRL = 0x454; // Sniffer Control
const SNIFF_DATA = 0x458; // Data accumulator for sniff hardware
const FIFO_LEVELS = 0x460; // Debug RAF, WAF, TDF levels
const CHAN_ABORT = 0x464; // Abort an in-progress transfer sequence on one or more channels
const N_CHANNELS = 0x468;

// CHn_CTRL_TRIG bits
const AHB_ERROR = 1 << 31;
const READ_ERROR = 1 << 30;
const WRITE_ERROR = 1 << 29;
const BUSY = 1 << 26;
const SNIFF_EN = 1 << 25;
const BSWAP = 1 << 24;
const IRQ_QUIET = 1 << 23;
const TREQ_SEL_MASK = 0x3f;
const TREQ_SEL_SHIFT = 17;
const CHAIN_TO_MASK = 0xf;
const CHAIN_TO_SHIFT = 13;
const RING_SEL = 1 << 12;
const RING_SIZE_MASK = 0xf;
const RING_SIZE_SHIFT = 8;
const INCR_WRITE_REV = 1 << 7; //TODO
const INCR_WRITE = 1 << 6;
const INCR_READ_REV = 1 << 5; //TODO
const INCR_READ = 1 << 4;
const DATA_SIZE_MASK = 0x3;
const DATA_SIZE_SHIFT = 2;
const HIGH_PRIORITY = 1 << 1;
const EN = 1 << 0;
const CHn_CTRL_TRIG_WRITE_MASK = 0xffffff;
const CHn_CTRL_TRIG_WC_MASK = READ_ERROR | WRITE_ERROR;

// Which transfer function fire() uses — resolved once when CTRL is written
// (matching real hardware, which captures it then rather than re-checking
// BSWAP on every fire()).
enum TransferKind {
  Direct8,
  Direct16,
  Swap16,
  Direct32,
  Swap32,
}

export class RP2350DMAChannel<ChipType extends IRPChip = IRPChip> implements AlarmCallback {
  private ctrl = 0;
  private readAddr = 0;
  private writeAddr = 0;
  private transCount = 0;
  private dreqCounter = 0;
  private transCountReload = 0;
  private transMode = 0;
  private treqValue = 0;
  private dataSize = 1;
  private transferKind = TransferKind.Direct8;
  private chainTo = 0;
  private ringMask = 0;
  private transferAlarm: IAlarm;

  constructor(readonly dma: RP2350DMA, readonly rpchip: ChipType, readonly index: number) {
    this.transferAlarm = rpchip.clock.createAlarm(this);
    this.reset();
  }

  start() {
    if (!(this.ctrl & EN) || this.ctrl & BUSY) {
      return;
    }
    this.ctrl |= BUSY;
    this.transCount = this.transCountReload;
    if (this.transCount) {
      this.scheduleTransfer();
    }
  }

  get treq() {
    return this.treqValue;
  }

  get active() {
    return this.ctrl & EN && this.ctrl & BUSY;
  }

  transfer8() {
    const { rpchip } = this;
    rpchip.writeUint8(this.writeAddr, rpchip.readUint8(this.readAddr));
  }

  transfer16() {
    const { rpchip } = this;
    rpchip.writeUint16(this.writeAddr, rpchip.readUint16(this.readAddr));
  }

  transferSwap16() {
    const { rpchip } = this;
    const input = rpchip.readUint16(this.readAddr);
    rpchip.writeUint16(this.writeAddr, ((input & 0xff) << 8) | (input >> 8));
  }

  transfer32() {
    const { rpchip } = this;
    rpchip.writeUint32(this.writeAddr, rpchip.readUint32(this.readAddr));
  }

  transferSwap32() {
    const { rpchip } = this;
    const input = rpchip.readUint32(this.readAddr);
    rpchip.writeUint32(
      this.writeAddr,
      ((input & 0x000000ff) << 24) |
        ((input & 0x0000ff00) << 8) |
        ((input & 0x00ff0000) >> 8) |
        ((input >> 24) & 0xff)
    );
  }

  fire() {
    const { ctrl, dataSize, ringMask } = this;
    switch (this.transferKind) {
      case TransferKind.Direct16:
        this.transfer16();
        break;
      case TransferKind.Swap16:
        this.transferSwap16();
        break;
      case TransferKind.Direct32:
        this.transfer32();
        break;
      case TransferKind.Swap32:
        this.transferSwap32();
        break;
      default:
        this.transfer8();
    }
    if (ctrl & INCR_READ) {
      if (ringMask && !(ctrl & RING_SEL)) {
        this.readAddr = (this.readAddr & ~ringMask) | ((this.readAddr + dataSize) & ringMask);
      } else {
        this.readAddr += dataSize;
      }
    }
    if (ctrl & INCR_WRITE) {
      if (ringMask && ctrl & RING_SEL) {
        this.writeAddr = (this.writeAddr & ~ringMask) | ((this.writeAddr + dataSize) & ringMask);
      } else {
        this.writeAddr += dataSize;
      }
    }
    if (this.transMode != 0xf) {
      this.transCount--;
    }
    if (this.transCount > 0) {
      this.scheduleTransfer();
    } else {
      if (!(this.ctrl & IRQ_QUIET)) {
        this.dma.intRaw |= 1 << this.index;
        this.dma.checkInterrupts();
      }
      if (this.chainTo !== this.index) {
        // `chainTo` is masked to CHAIN_TO_MASK (0-15) and `channels` is a full
        // Array(CHANNEL_COUNT === 16), so this index is always valid — no `?.`
        // needed (which cts2c can't transpile anyway).
        this.dma.channels[this.chainTo].start();
      }
      if (this.transMode == 1) {
        this.transCount = this.transCountReload;
        this.scheduleTransfer();
      } else {
        this.ctrl &= ~BUSY;
      }
    }
  }

  scheduleTransfer() {
    if (this.dma.dreq[this.treqValue] || this.treqValue === TREQ.Permanent) {
      this.transferAlarm.schedule(0);
    } else {
      const delay = this.dma.getTimer(this.treqValue);
      if (delay) {
        this.transferAlarm.schedule(delay * 1000);
      }
    }
  }

  abort() {
    this.ctrl &= ~BUSY;
    this.transferAlarm.cancel();
  }

  readUint32(offset: number) {
    switch (offset) {
      case CHn_READ_ADDR:
      case CHn_AL1_READ_ADDR:
      case CHn_AL2_READ_ADDR:
      case CHn_AL3_READ_ADDR_TRIG:
        return this.readAddr;

      case CHn_WRITE_ADDR:
      case CHn_AL1_WRITE_ADDR:
      case CHn_AL2_WRITE_ADDR_TRIG:
      case CHn_AL3_WRITE_ADDR:
        return this.writeAddr;

      case CHn_TRANS_COUNT:
      case CHn_AL1_TRANS_COUNT_TRIG:
      case CHn_AL2_TRANS_COUNT:
      case CHn_AL3_TRANS_COUNT:
        return this.transCount;

      case CHn_CTRL_TRIG:
      case CHn_AL1_CTRL:
      case CHn_AL2_CTRL:
      case CHn_AL3_CTRL:
        return this.ctrl;

      case CHn_DBG_CTDREQ:
        return this.dreqCounter;

      case CHn_DBG_TCR:
        return this.transCountReload;
    }

    return 0;
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case CHn_READ_ADDR:
      case CHn_AL1_READ_ADDR:
      case CHn_AL2_READ_ADDR:
      case CHn_AL3_READ_ADDR_TRIG:
        this.readAddr = value;
        break;

      case CHn_WRITE_ADDR:
      case CHn_AL1_WRITE_ADDR:
      case CHn_AL2_WRITE_ADDR_TRIG:
      case CHn_AL3_WRITE_ADDR:
        this.writeAddr = value;
        break;

      case CHn_TRANS_COUNT:
      case CHn_AL1_TRANS_COUNT_TRIG:
      case CHn_AL2_TRANS_COUNT:
      case CHn_AL3_TRANS_COUNT:
        this.transCountReload = value & 0x0fffffff;
        this.transMode = value >>> 28;
        break;

      case CHn_CTRL_TRIG:
      case CHn_AL1_CTRL:
      case CHn_AL2_CTRL:
      case CHn_AL3_CTRL: {
        this.ctrl = (this.ctrl & ~CHn_CTRL_TRIG_WRITE_MASK) | (value & CHn_CTRL_TRIG_WRITE_MASK);
        this.ctrl &= ~(value & CHn_CTRL_TRIG_WC_MASK); // Handle write-clear (WC) bits
        this.treqValue = (this.ctrl >> TREQ_SEL_SHIFT) & TREQ_SEL_MASK;
        this.chainTo = (this.ctrl >> CHAIN_TO_SHIFT) & CHAIN_TO_MASK;
        const ringSize = (this.ctrl >> RING_SIZE_SHIFT) & RING_SIZE_MASK;
        this.ringMask = ringSize ? (1 << ringSize) - 1 : 0;
        switch ((this.ctrl >> DATA_SIZE_SHIFT) & DATA_SIZE_MASK) {
          case 1:
            this.dataSize = 2;
            this.transferKind = this.ctrl & BSWAP ? TransferKind.Swap16 : TransferKind.Direct16;
            break;
          case 2:
            this.dataSize = 4;
            this.transferKind = this.ctrl & BSWAP ? TransferKind.Swap32 : TransferKind.Direct32;
            break;
          case 0:
          default:
            this.dataSize = 1;
            this.transferKind = TransferKind.Direct8;
        }
        if (this.ctrl & EN && this.ctrl & BUSY) {
          this.scheduleTransfer();
        }
        if (!(this.ctrl & EN)) {
          this.transferAlarm.cancel();
        }
        break;
      }

      case CHn_DBG_CTDREQ:
        this.dreqCounter = 0;
        break;
    }

    if (
      offset === CHn_AL3_READ_ADDR_TRIG ||
      offset === CHn_AL2_WRITE_ADDR_TRIG ||
      offset === CHn_AL1_TRANS_COUNT_TRIG ||
      offset === CHn_CTRL_TRIG
    ) {
      if (value) {
        this.start();
      } else if (this.ctrl & IRQ_QUIET) {
        // Null trigger interrupts
        this.dma.intRaw |= 1 << this.index;
        this.dma.checkInterrupts();
      }
    }
  }

  reset() {
    this.writeUint32(CHn_CTRL_TRIG, this.index << CHAIN_TO_SHIFT);
  }
}

export class RP2350DMA<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  readonly channels: Array<RP2350DMAChannel> = Array(CHANNEL_COUNT)
    .fill(0)
    .map((v, i) => new RP2350DMAChannel(this, this.rpchip, i));

  intRaw = 0;
  private intEnable = [0, 0, 0, 0];
  private intForce = [0, 0, 0, 0];
  private timer0 = 0;
  private timer1 = 0;
  private timer2 = 0;
  private timer3 = 0;

  readonly dreq: boolean[] = Array(DREQChannel.DREQ_MAX);

  constructor(readonly rpchip: ChipType, name: string, readonly dma_irq_base: number) {
    super(rpchip, name);
  }

  intStatus(intNum: number) {
    return (this.intRaw & this.intEnable[intNum]) | this.intForce[intNum];
  }

  intNumFromOffset(offset: number) {
    return ((offset - INTE0) / (INTE1 - INTE0)) >>> 0;
  }

  readUint32(offset: number) {
    if (offset % DEBUG_REGISTER_START < CHANNEL_COUNT * REGISTERS_SIZE_PER_CHANNEL) {
      // this handles both the normal CHn registers (starting at 0x0) as well as the CHn_DBG registers (starting at DEBUG_REGISTER_START)
      const channelIndex = ((offset % DEBUG_REGISTER_START) / REGISTERS_SIZE_PER_CHANNEL) >>> 0;
      return this.channels[channelIndex].readUint32(
        offset & (DEBUG_REGISTER_START | (REGISTERS_SIZE_PER_CHANNEL - 1))
      );
    }
    switch (offset) {
      case TIMER0:
        return this.timer0;
      case TIMER1:
        return this.timer1;
      case TIMER2:
        return this.timer2;
      case TIMER3:
        return this.timer3;
      case INTR:
        return this.intRaw;
      case INTE0:
      case INTE1:
      case INTE2:
      case INTE3:
        return this.intEnable[this.intNumFromOffset(offset)];
      case INTF0:
      case INTF1:
      case INTF2:
      case INTF3:
        return this.intForce[this.intNumFromOffset(offset)];
      case INTS0:
      case INTS1:
      case INTS2:
      case INTS3:
        return this.intStatus(this.intNumFromOffset(offset));
      case CHAN_ABORT:
        return 0;
      case N_CHANNELS:
        return this.channels.length;
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    if (offset % DEBUG_REGISTER_START < CHANNEL_COUNT * REGISTERS_SIZE_PER_CHANNEL) {
      // this handles both the normal CHn registers (starting at 0x0) as well as the CHn_DBG registers (starting at DEBUG_REGISTER_START)
      const channelIndex = ((offset % DEBUG_REGISTER_START) / REGISTERS_SIZE_PER_CHANNEL) >>> 0;
      this.channels[channelIndex].writeUint32(
        offset & (DEBUG_REGISTER_START | (REGISTERS_SIZE_PER_CHANNEL - 1)),
        value
      );
      return;
    }
    switch (offset) {
      case TIMER0:
        this.timer0 = value;
        return;
      case TIMER1:
        this.timer1 = value;
        return;
      case TIMER2:
        this.timer2 = value;
        return;
      case TIMER3:
        this.timer3 = value;
        return;
      case INTR:
      case INTS0:
      case INTS1:
      case INTS2:
      case INTS3:
        this.intRaw &= ~this.rawWriteValue;
        this.checkInterrupts();
        return;
      case INTE0:
      case INTE1:
      case INTE2:
      case INTE3:
        this.intEnable[this.intNumFromOffset(offset)] = value & 0xffff;
        this.checkInterrupts();
        return;
      case INTF0:
      case INTF1:
      case INTF2:
      case INTF3:
        this.intForce[this.intNumFromOffset(offset)] = value & 0xffff;
        this.checkInterrupts();
        return;
      case MULTI_CHAN_TRIGGER:
        for (const chan of this.channels) {
          if (value & (1 << chan.index)) {
            chan.start();
          }
        }
        return;
      case CHAN_ABORT:
        for (const chan of this.channels) {
          if (value & (1 << chan.index)) {
            chan.abort();
          }
        }
        return;
      default:
        super.writeUint32(offset, value);
    }
  }

  setDREQ(dreqChannel: DREQChannel) {
    const { dreq } = this;
    if (!dreq[dreqChannel]) {
      dreq[dreqChannel] = true;
      for (const channel of this.channels) {
        if (channel.treq === dreqChannel && channel.active) {
          channel.scheduleTransfer();
        }
      }
    }
  }

  clearDREQ(dreqChannel: DREQChannel) {
    this.dreq[dreqChannel] = false;
  }

  /**
   * Returns the number of microseconds for a cycle of the given DMA timer, or 0 if the timer is disabled.
   */
  getTimer(treq: TREQ) {
    let dividend = 0,
      divisor = 1;
    switch (treq) {
      case TREQ.Permanent:
        dividend = 1;
        divisor = 1;
        break;
      case TREQ.Timer0:
        dividend = this.timer0 >>> 16;
        divisor = this.timer0 & 0xffff;
        break;
      case TREQ.Timer1:
        dividend = this.timer1 >>> 16;
        divisor = this.timer1 & 0xffff;
        break;
      case TREQ.Timer2:
        dividend = this.timer2 >>> 16;
        divisor = this.timer2 & 0xffff;
        break;
      case TREQ.Timer3:
        dividend = this.timer3 >>> 16;
        divisor = this.timer3 & 0xffff;
        break;
    }
    if (divisor === 0) {
      return 0;
    }
    return ((dividend / divisor) * 1e6) / this.rpchip.clkSys;
  }

  checkInterrupts() {
    this.rpchip.setInterrupt(this.dma_irq_base + 0, !!this.intStatus(0));
    this.rpchip.setInterrupt(this.dma_irq_base + 1, !!this.intStatus(1));
    this.rpchip.setInterrupt(this.dma_irq_base + 2, !!this.intStatus(2));
    this.rpchip.setInterrupt(this.dma_irq_base + 3, !!this.intStatus(3));
  }
}
