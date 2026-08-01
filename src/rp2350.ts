import { IRPChip } from './rpchip';
import { SimulationClock } from './clock/simulation-clock';
import { ICpuCore } from './cpu-core';
import { CPU } from './riscv/cpu';
import {
  GPIOPin,
  FUNCTION_PWM,
  FUNCTION_SIO,
  FUNCTION_PIO0,
  FUNCTION_PIO1,
  FUNCTION_PIO2,
} from './gpio-pin';
import { IRQ2350 } from './irq_rp2350';
import { RPADC } from './peripherals/adc';
import { RPBUSCTRL } from './peripherals/busctrl';
import { RPBootRAM } from './peripherals/bootram';
import { RP2350POWMAN } from './peripherals/powman_rp2350';
import { RP2350PSM } from './peripherals/psm_rp2350';
import { RP2350SHA256 } from './peripherals/sha256_rp2350';
import { RP2350TRNG } from './peripherals/trng_rp2350';
import { RP2350OTP, RP2350OTPData } from './peripherals/otp_data_rp2350';
import { RPClocks } from './peripherals/clocks';
import { DREQChannel, RPDMA } from './peripherals/dma_rp2350';
import { RPI2C } from './peripherals/i2c';
import { RPIO } from './peripherals/io_rp2350';
import { RPPADS } from './peripherals/pads_rp2350';
import { Peripheral, UnimplementedPeripheral } from './peripherals/peripheral';
import { RPPIO, WaitType } from './peripherals/pio';
import { RPPWM } from './peripherals/pwm';
import { RP2350PLL } from './peripherals/pll_rp2350';
import { RPReset } from './peripherals/reset';
import { RP2040RTC } from './peripherals/rtc';
import { RPSPI } from './peripherals/spi';
import { RP2350SysCfg } from './peripherals/syscfg_rp2350';
import { RP2350SysInfo } from './peripherals/sysinfo_rp2350';
import { RPTBMAN } from './peripherals/tbman';
import { RPTimer } from './peripherals/timer';
import { RPUART } from './peripherals/uart';
import { RPUSBController } from './peripherals/usb';
import { RPXIPQMI } from './peripherals/xip_rp2350';
import { RPSIO } from './sio_rp2350';
import { RPWatchdog } from './peripherals/watchdog';
import { ConsoleLogger, Logger, LogLevel } from './utils/logging';
import { CortexM33Core } from './cortex-m33/core';
import { RPPPB2350 } from './peripherals/ppb_rp2350';
import { bootrom_rp2350_A2 } from './bootroms';
import { loadFirmware, LoadFirmwareOptions, LoadFirmwareResult } from './utils/load-firmware';
import { Uint32, Float64 } from './utils/types';

export const FLASH_START_ADDRESS = 0x10000000;
export const RAM_START_ADDRESS = 0x20000000;
export const APB_START_ADDRESS = 0x40000000;
export const DPRAM_START_ADDRESS = 0x50100000;
export const SIO_START_ADDRESS = 0xd0000000;
/** Private Peripheral Bus base (ARMv8-M PPB, per-core). */
export const PPB_START_ADDRESS = 0xe0000000;
/** End of internal PPB region (exclusive). */
export const PPB_END_ADDRESS = 0xe1000000;

const LOG_NAME = 'RP2350';

const KB = 1024;
const MB = 1024 * KB;
const MHz = 1_000_000;

const FLASH_SIZE = 16 * MB;

/** Architecture selection for the two processor sockets on RP2350. */
export type CoreArch = 'riscv' | 'arm';

/** Constructor options for {@link RP2350}. */
export interface RP2350Options {
  /**
   * Architecture for both processor sockets. The RP2350 has two sockets each
   * of which may be a Cortex-M33 or a Hazard3 RISC-V; v1 of this emulator
   * requires homogeneous combos (both sockets the same arch).
   *
   * Defaults to `'riscv'` so existing rp2350js code keeps working unchanged.
   * Real silicon's factory default is `'arm'` (per datasheet §3.9 critical
   * OTP flags) but emulator consumers have historically expected RISC-V.
   */
  coreArch?: CoreArch;
  /** Path to a HEX/UF2 firmware image to load after initial reset. */
  loadFirmware?: string;
}

export class RP2350 implements IRPChip {
  readonly bootrom = new Uint32Array((32 >>> 2) * KB);
  readonly bootromBytes: Uint32 = this.bootrom.length * 4;
  readonly sram = new Uint8Array((256 * 2 + 8) * KB);
  readonly sram32 = new Uint32Array(this.sram.buffer);
  readonly sram16 = new Uint16Array(this.sram.buffer);
  readonly flash = new Uint8Array(FLASH_SIZE);
  readonly flash16 = new Uint16Array(this.flash.buffer);
  readonly flash32 = new Uint32Array(this.flash.buffer);
  readonly usbDPRAM = new Uint8Array(4 * KB);
  readonly usbDPRAMView = new DataView(this.usbDPRAM.buffer);

  readonly identifier = 'rp2350';

  /** Architecture of both cores (homogeneous in v1). */
  readonly coreArch: CoreArch;

  // Cached `coreArch === 'arm'` to avoid repeated string comparisons in the hot
  // memory access path (transpiled C build: strcmp() costs ~8-10% runtime).
  readonly isArmCore: boolean;

  /**
   * CPU cores. The concrete element type depends on {@link coreArch}:
   * `CPU` (Hazard3 RISC-V) when 'riscv', `CortexM33Core` when 'arm'. Consumers
   * that need the concrete type should narrow via {@link riscvCore0}/
   * {@link riscvCore1} or {@link armCore0}/{@link armCore1}.
   */
  readonly core: ICpuCore[];

  /** RISC-V core 0 (only valid when coreArch === 'riscv'). */
  get riscvCore0(): CPU {
    return this.core[0] as CPU;
  }
  /** RISC-V core 1 (only valid when coreArch === 'riscv'). */
  get riscvCore1(): CPU {
    return this.core[1] as CPU;
  }
  /** ARM Cortex-M33 core 0 (only valid when coreArch === 'arm'). */
  get armCore0(): CortexM33Core {
    return this.core[0] as CortexM33Core;
  }
  /** ARM Cortex-M33 core 1 (only valid when coreArch === 'arm'). */
  get armCore1(): CortexM33Core {
    return this.core[1] as CortexM33Core;
  }

  /**
   * Per-core Private Peripheral Bus (NVIC, SCB, SysTick, MPU, SAU, FP).
   * Present only when {@link coreArch} === 'arm'; undefined for RISC-V
   * (RISC-V uses its own CSR-based interrupt controller via SIO).
   */
  readonly ppb?: RPPPB2350;

  // Back-compat accessors (only valid when coreArch === 'riscv') ----------------
  get core0(): CPU {
    return this.core[0] as CPU;
  }
  get core1(): CPU {
    return this.core[1] as CPU;
  }

  /* Clocks */
  readonly clock = new SimulationClock();
  clkSys = 125 * MHz;
  clkPeri = 125 * MHz;

  readonly sio = new RPSIO(
    this,
    IRQ2350.SIO_IRQ_FIFO,
    IRQ2350.SIO_IRQ_FIFO,
    IRQ2350.SIO_IRQ_MTIMECMP
  );

  /** RP2350 OTP fuse array and control interface. */
  readonly otp = new RP2350OTP(this, 'OTP_BASE');

  readonly watchdog = new RPWatchdog(this, 'WATCHDOG_BASE');

  readonly uart = [
    new RPUART(this, 'UART0', IRQ2350.UART0_IRQ, {
      rx: DREQChannel.DREQ_UART0_RX,
      tx: DREQChannel.DREQ_UART0_TX,
    }),
    new RPUART(this, 'UART1', IRQ2350.UART1_IRQ, {
      rx: DREQChannel.DREQ_UART1_RX,
      tx: DREQChannel.DREQ_UART1_TX,
    }),
  ];
  readonly i2c = [
    new RPI2C(this, 'I2C0', IRQ2350.I2C0_IRQ),
    new RPI2C(this, 'I2C1', IRQ2350.I2C1_IRQ),
  ];
  readonly pwm = new RPPWM(this, 'PWM_BASE', IRQ2350.PWM_IRQ_WRAP_0, DREQChannel.DREQ_PWM_WRAP0);
  readonly adc = new RPADC(this, 'ADC', IRQ2350.ADC_IRQ_FIFO, DREQChannel.DREQ_ADC);

  readonly gpio: Array<GPIOPin> = Array(48)
    .fill(0)
    .map((v, i) => new GPIOPin(this, i));

  readonly qspi: Array<GPIOPin> = [
    new GPIOPin(this, 0, 'SCLK'),
    new GPIOPin(this, 1, 'SS'),
    new GPIOPin(this, 2, 'SD0'),
    new GPIOPin(this, 3, 'SD1'),
    new GPIOPin(this, 4, 'SD2'),
    new GPIOPin(this, 5, 'SD3'),
  ];

  readonly dma = new RPDMA(this, 'DMA', IRQ2350.DMA_IRQ_0);
  readonly pio: Array<RPPIO> = [
    new RPPIO(
      this,
      'PIO0',
      IRQ2350.PIO0_IRQ_0,
      0,
      DREQChannel.DREQ_PIO0_RX0,
      DREQChannel.DREQ_PIO0_TX0
    ),
    new RPPIO(
      this,
      'PIO1',
      IRQ2350.PIO1_IRQ_0,
      1,
      DREQChannel.DREQ_PIO1_RX0,
      DREQChannel.DREQ_PIO1_TX0
    ),
    new RPPIO(
      this,
      'PIO2',
      IRQ2350.PIO2_IRQ_0,
      2,
      DREQChannel.DREQ_PIO2_RX0,
      DREQChannel.DREQ_PIO2_TX0
    ),
  ];
  readonly usbCtrl = new RPUSBController(this, 'USB', IRQ2350.USBCTRL_IRQ);
  readonly spi = [
    new RPSPI(this, 'SPI0', IRQ2350.SPI0_IRQ, {
      rx: DREQChannel.DREQ_SPI0_RX,
      tx: DREQChannel.DREQ_SPI0_TX,
    }),
    new RPSPI(this, 'SPI1', IRQ2350.SPI1_IRQ, {
      rx: DREQChannel.DREQ_SPI1_RX,
      tx: DREQChannel.DREQ_SPI1_TX,
    }),
  ];

  public logger: Logger = new ConsoleLogger(LogLevel.Debug, true);

  readonly peripherals: { [index: number]: Peripheral } = {
    0x40000: new RP2350SysInfo(this, 'SYSINFO_BASE'),
    0x40008: new RP2350SysCfg(this, 'SYSCFG'),
    0x40010: new RPClocks(this, 'CLOCKS_BASE'),
    0x40018: new RP2350PSM(this, 'PSM_BASE'),
    0x40020: new RPReset(this, 'RESETS_BASE'),
    0x40028: new RPIO(this, 'IO_BANK0_BASE'),
    0x40030: new UnimplementedPeripheral(this, 'IO_QSPI_BASE'),
    0x40038: new RPPADS(this, 'PADS_BANK0_BASE', 'bank0'),
    0x40040: new RPPADS(this, 'PADS_QSPI_BASE', 'qspi'),
    0x40048: new UnimplementedPeripheral(this, 'XOSC_BASE'),
    0x40050: new RP2350PLL(this, 'PLL_SYS_BASE'),
    0x40058: new UnimplementedPeripheral(this, 'PLL_USB_BASE'),
    0x40060: new UnimplementedPeripheral(this, 'ACCESSCTRL_BASE'),
    0x40068: new UnimplementedPeripheral(this, 'BUSCTRL_BASE'), //TODO new RPBUSCTRL(this, 'BUSCTRL_BASE'),
    0x40070: this.uart[0],
    0x40078: this.uart[1],
    0x40080: this.spi[0],
    0x40088: this.spi[1],
    0x40090: this.i2c[0],
    0x40098: this.i2c[1],
    0x400a0: this.adc,
    0x400a8: this.pwm,
    0x400b0: new RPTimer(this, 'TIMER0_BASE', IRQ2350.TIMER0_IRQ_0),
    0x400b8: new RPTimer(this, 'TIMER1_BASE', IRQ2350.TIMER1_IRQ_0),
    0x400c0: new UnimplementedPeripheral(this, 'HSTX_CTRL_BASE'),
    0x400c8: new UnimplementedPeripheral(this, 'XIP_CTRL_BASE'),
    0x400d0: new RPXIPQMI(this, 'XIP_QMI_BASE'),
    0x400d8: this.watchdog,
    0x400dc: this.watchdog,

    //0x400xx: new RP2040RTC(this, 'RTC_BASE'),
    0x400e0: new RPBootRAM(this, 'BOOTRAM_BASE'),
    0x400e8: new UnimplementedPeripheral(this, 'ROSC_BASE'),
    0x400f0: new RP2350TRNG(this, 'TRNG_BASE'),
    0x400f8: new RP2350SHA256(this, 'SHA256_BASE'),
    0x40100: new RP2350POWMAN(this, 'POWMAN_BASE'),
    0x40108: new UnimplementedPeripheral(this, 'TICKS_BASE'),
    0x40120: this.otp,
    // OTP_DATA window (16KB at 0x40130000). Spans 4 x 16KB APB blocks.
    0x40130: new RP2350OTPData(this, 'OTP_DATA', this.otp),
    0x40134: new RP2350OTPData(this, 'OTP_DATA', this.otp),
    0x40138: new RP2350OTPData(this, 'OTP_DATA', this.otp),
    0x4013c: new RP2350OTPData(this, 'OTP_DATA', this.otp),
    0x40160: new RPTBMAN(this, 'TBMAN_BASE'),

    0x50000: this.dma,
    0x50110: this.usbCtrl,
    0x50200: this.pio[0],
    0x50300: this.pio[1],
    0x50400: this.pio[2],
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  public onTrace = (coreNumber: number, pc: number, tag: string) => {};

  constructor(options: RP2350Options = {}) {
    this.coreArch = options.coreArch ?? 'riscv';
    this.isArmCore = this.coreArch === 'arm';
    if (this.isArmCore) {
      this.core = [new CortexM33Core(this, 'ARMCore0', 0), new CortexM33Core(this, 'ARMCore1', 1)];
      this.ppb = new RPPPB2350(this, 'PPB');
    } else {
      this.core = [new CPU(this, 'RISCVCore0', 0), new CPU(this, 'RISCVCore1', 1)];
    }

    // OTP ARCHSEL/ARCHSEL_STATUS (0x158/0x15c, bit0=core0, bit1=core1): the
    // bootrom reads ARCHSEL_STATUS to detect a CPU/image architecture
    // mismatch and reboot into the other arch. Since this emulator fixes one
    // architecture for the chip's lifetime, both registers must match
    // `coreArch` up front, or the bootrom loops forever requesting a switch.
    const archsel = this.coreArch === 'riscv' ? 0b11 : 0b00;
    this.otp.writeUint32(0x158, archsel);
    this.otp.writeUint32(0x15c, archsel);

    // Auto-load the bundled A2 bootrom and erased-flash state before the
    // initial reset, so freshly-constructed chips boot the same way real
    // silicon does. Subsequent reset() calls preserve flash contents
    // (matching hardware); callers can override the bootrom via a
    // subsequent `loadBootrom(...)` call.
    this.bootrom.set(bootrom_rp2350_A2);
    this.flash.fill(0xff);

    this.reset();
    this.core[0].setOtherCore(this.core[1]);
    this.core[1].setOtherCore(this.core[0]);

    // Set QSPI CSn pull-up (BOOTSEL not pressed). On real hardware, the flash
    // chip's CSn line has a pull-up resistor. Without this, the bootrom thinks
    // BOOTSEL is pressed and enters USB bootloader instead of flash boot.
    // Need IE=1 (bit 6) in padValue for the SIO GPIO_HI_IN read to see the pin.
    this.qspi[1].padValue = 0x56; // IE=1, PUE=1, ISO=1
    this.qspi[1].setInputValue(true);

    // Watchdog reset: per PSM WDSEL configuration in the bootrom
    // (psm_hw->wdsel = ~PSM_WDSEL_PROC_COLD_BITS), this resets nearly the
    // full chip — cores, peripherals, and the watchdog's own CTRL/LOAD —
    // matching real silicon. Watchdog scratch is outside the PSM reset
    // scope, so vectored-boot info survives.
    this.watchdog.onWatchdogTrigger = () => {
      this.logger.warn('WATCHDOG', 'Watchdog fired — resetting chip');
      this.reset();
      this.watchdog.reset();
    };

    if (options.loadFirmware) {
      this.loadFirmware(options.loadFirmware);
    }
  }

  currentCore = 0;
  loadBootrom(bootromData: Uint32Array) {
    this.bootrom.set(bootromData);
    this.reset();
  }

  disassembly = '';
  loadDisassembly(dis: string) {
    this.disassembly = dis;
  }

  /**
   * Load firmware from a HEX or UF2 file, then (by default) re-initialise
   * the chip so the cores start ready to boot the loaded image.
   *
   * For SRAM images, watchdog scratch[4..7] is set up as a vectored-boot
   * handshake so the bootrom scans the SRAM window for an IMAGE_DEF block
   * and launches the firmware (replicating what nsboot does on real
   * hardware after a UF2 upload). For flash images, the bootrom does its
   * normal flash scan.
   *
   * See `src/utils/load-firmware.ts` for option details (override entry PC,
   * skip chip init, etc.).
   */
  loadFirmware(path: string, options?: LoadFirmwareOptions): LoadFirmwareResult {
    return loadFirmware(this, path, options);
  }

  /**
   * @param enableCoprocessors ARM only: when true, sets CPACR to enable full
   * access to all 8 coprocessor slots (CP0-CP11) directly, matching what the
   * real bootrom does during its own boot sequence. Defaults to false (real
   * ARMv8-M reset state: all coprocessors disabled) so that booting *through*
   * the emulated bootrom — which sets CPACR itself — isn't short-circuited.
   * Callers that skip the bootrom (e.g. jumping straight to a firmware reset
   * vector) can pass true to get FPU/DSP access without replicating the
   * bootrom's own CPACR setup.
   */
  reset(enableCoprocessors = false) {
    if (this.isArmCore) {
      for (const c of this.core as CortexM33Core[]) c.reset(enableCoprocessors);
    } else {
      for (const c of this.core) c.reset();
    }
    this.pwm.reset();
  }

  readUint32(address: Uint32): Uint32 {
    address = address >>> 0; // round to 32-bits, unsigned
    if (address & 0x3) {
      // Only LDR/STR singles, LDRH/STRH, and TBH may access unaligned
      // addresses (handled separately in execute-thumb16.ts/execute-
      // thumb32.ts via byte-composed reads that never reach this method).
      // Anything that still calls readUint32 with an unaligned address is
      // LDM/LDRD or an exclusive/acquire-release access, which the M33
      // requires to be word-aligned and faults on otherwise (RP2350
      // datasheet / ARMv8-M ARM §B8.3).
      const pc = this.core[this.currentCore]?.PC;
      throw Error(
        `${LOG_NAME} unaligned word read from address ${address.toString(16)} at PC=${
          pc !== undefined ? pc.toString(16) : 'unknown'
        } (core${this.currentCore})`
      );
    }
    // Ordered by hit frequency, not address value: SRAM/flash (data/code, the
    // hottest ranges — every instruction fetch lands here) are checked before
    // SIO/PPB/peripherals/bootrom/DPRAM, which are comparatively rare per-step.
    if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      return this.sram32[(address - RAM_START_ADDRESS) >>> 2];
    } else if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
      // XIP mirrors flash four times. Also, reads from invalid adresses
      // don't seem to trigger exceptions (see Micropython)
      return this.flash32[(address & (FLASH_SIZE - 1)) >>> 2];
    } else if (address >= SIO_START_ADDRESS && address < SIO_START_ADDRESS + 0x10000000) {
      return this.sio.readUint32(address - SIO_START_ADDRESS, this.currentCore);
    } else if (this.isArmCore && address >= 0xe0020000 && address < 0xe0030000) {
      // NS PPB alias (TrustZone). Strip bit 17 to map to secure PPB offset.
      return this.ppb!.readUint32ViaCore(address & 0xfffdffff & 0xffffff, this.currentCore);
    } else if (this.isArmCore && address >= PPB_START_ADDRESS && address < PPB_END_ADDRESS) {
      // ARMv8-M PPB (per-core NVIC/SCB/SysTick/MPU/SAU/FP).
      return this.ppb!.readUint32ViaCore(address & 0xffffff, this.currentCore);
    }

    const peripheral = this.findPeripheral(address);
    if (peripheral) {
      return peripheral.readUint32(address & 0x3fff);
    }

    if (address < this.bootromBytes) {
      return this.bootrom[address >>> 2];
    } else if (
      address >= DPRAM_START_ADDRESS &&
      address < DPRAM_START_ADDRESS + this.usbDPRAM.length
    ) {
      return this.usbDPRAMView.getUint32(address - DPRAM_START_ADDRESS, true);
    }

    {
      const pc = this.core[this.currentCore]?.PC;
      throw Error(
        `${LOG_NAME} Read from invalid memory address: ${address.toString(16)} at PC=${
          pc !== undefined ? pc.toString(16) : 'unknown'
        } (core${this.currentCore})`
      );
    }
    //return 0xffffffff;
  }

  findPeripheral(address: Uint32): Peripheral {
    return this.peripherals[(address >>> 14) << 2];
  }

  /** We assume the address is 16-bit aligned */
  readUint16(address: Uint32): Uint32 {
    // Same SRAM-before-flash ordering as readUint32, for consistency.
    if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      return this.sram16[(address - RAM_START_ADDRESS) >>> 1];
    } else if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
      return this.flash16[(address & (FLASH_SIZE - 1)) >>> 1];
    }

    const value = this.readUint32(address & 0xfffffffc);
    return address & 0x2 ? (value & 0xffff0000) >>> 16 : value & 0xffff;
  }

  readUint8(address: Uint32): Uint32 {
    if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
      return this.flash[address & (FLASH_SIZE - 1)];
    } else if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      return this.sram[address - RAM_START_ADDRESS];
    }

    const value = this.readUint16(address & 0xfffffffe);
    return (address & 0x1 ? (value & 0xff00) >>> 8 : value & 0xff) >>> 0;
  }

  writeUint32(address: Uint32, value: Uint32) {
    address = address >>> 0;
    if (address & 0x3) {
      const pc = this.core[this.currentCore]?.PC;
      throw Error(
        `${LOG_NAME} unaligned word write to address ${address.toString(16)} at PC=${
          pc !== undefined ? pc.toString(16) : 'unknown'
        } (core${this.currentCore})`
      );
    }
    if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      this.sram32[(address - RAM_START_ADDRESS) >>> 2] = value;
    } else if (address >= SIO_START_ADDRESS && address < SIO_START_ADDRESS + 0x10000000) {
      this.sio.writeUint32(address - SIO_START_ADDRESS, value, this.currentCore);
    } else if (this.isArmCore && address >= 0xe0020000 && address < 0xe0030000) {
      // NS PPB alias (TrustZone). Strip bit 17.
      this.ppb!.writeUint32ViaCore(address & 0xfffdffff & 0xffffff, value, this.currentCore);
    } else if (this.isArmCore && address >= PPB_START_ADDRESS && address < PPB_END_ADDRESS) {
      // ARMv8-M PPB (per-core NVIC/SCB/SysTick/MPU/SAU/FP).
      this.ppb!.writeUint32ViaCore(address & 0xffffff, value, this.currentCore);
    } else {
      const peripheral = this.findPeripheral(address);
      if (peripheral) {
        const atomicType = (address & 0x3000) >> 12;
        const offset = address & 0xfff;
        peripheral.writeUint32Atomic(offset, value, atomicType);
      } else if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
        return; // "XIP memory is read-only by default" (writes get downgraded to reads)
      } else if (address < this.bootromBytes) {
        return; // Bootrom is mask ROM — real hardware silently ignores writes to it.
      } else if (
        address >= DPRAM_START_ADDRESS &&
        address < DPRAM_START_ADDRESS + this.usbDPRAM.length
      ) {
        const offset = address - DPRAM_START_ADDRESS;
        this.usbDPRAMView.setUint32(offset, value, true);
        this.usbCtrl.DPRAMUpdated(offset, value);
      } else {
        const pc = this.core[this.currentCore]?.PC;
        throw Error(
          `${LOG_NAME} Write to invalid memory address: ${address.toString(16)} at PC=${
            pc !== undefined ? pc.toString(16) : 'unknown'
          } (core${this.currentCore})`
        );
      }
    }
  }

  writeUint8(address: Uint32, value: Uint32) {
    if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      this.sram[address - RAM_START_ADDRESS] = value;
      return;
    }
    if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
      return;
    }

    const alignedAddress = (address & 0xfffffffc) >>> 0;
    const peripheral = this.findPeripheral(address);
    if (peripheral) {
      const shift = (address & 0x3) << 3;
      if (peripheral.byteAddressable()) {
        const offset = alignedAddress & 0x3fff;
        const originalValue = peripheral.readUint32(offset);
        peripheral.writeUint32(
          offset,
          (originalValue & ~(0xff << shift)) | ((value & 0xff) << shift)
        );
        return;
      }
      const atomicType = (alignedAddress & 0x3000) >> 12;
      const offset = alignedAddress & 0xfff;
      peripheral.writeUint32Atomic(
        offset,
        (value & 0xff) | ((value & 0xff) << 8) | ((value & 0xff) << 16) | ((value & 0xff) << 24),
        atomicType
      );
      return;
    }
    const shift = (address & 0x3) << 3;
    const originalValue = this.readUint32(alignedAddress);
    this.writeUint32(
      alignedAddress,
      (originalValue & ~(0xff << shift)) | ((value & 0xff) << shift)
    );
  }

  writeUint16(address: Uint32, value: Uint32) {
    // we assume that addess is 16-bit aligned.
    // Ideally we should generate a fault if not!

    if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + this.sram.length) {
      this.sram16[(address - RAM_START_ADDRESS) >>> 1] = value;
      return;
    }
    if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
      return;
    }

    const alignedAddress = (address & 0xfffffffc) >>> 0;
    const peripheral = this.findPeripheral(address);
    if (peripheral) {
      const shift = (address & 0x3) << 3;
      if (peripheral.byteAddressable()) {
        const offset = alignedAddress & 0x3fff;
        const originalValue = peripheral.readUint32(offset);
        peripheral.writeUint32(
          offset,
          (originalValue & ~(0xffff << shift)) | ((value & 0xffff) << shift)
        );
        return;
      }
      const atomicType = (alignedAddress & 0x3000) >> 12;
      const offset = alignedAddress & 0xfff;
      peripheral.writeUint32Atomic(offset, (value & 0xffff) | ((value & 0xffff) << 16), atomicType);
      return;
    }
    const shift = (address & 0x3) << 3;
    const originalValue = this.readUint32(alignedAddress);
    this.writeUint32(
      alignedAddress,
      (originalValue & ~(0xffff << shift)) | ((value & 0xffff) << shift)
    );
  }

  dma_clearDREQ(dreq: number) {
    this.dma.clearDREQ(dreq);
  }

  dma_setDREQ(dreq: number) {
    this.dma.setDREQ(dreq);
  }

  get cycles(): number {
    return this.core[0].getCycles();
  }

  gpioValues(start_index: number) {
    const { gpio } = this;
    let result = 0;
    const end_index = Math.min(start_index + 32, gpio.length);
    for (let gpioIndex = start_index; gpioIndex < end_index; gpioIndex++) {
      if (gpio[gpioIndex].inputValue) {
        result |= 1 << (gpioIndex - start_index);
      }
    }
    return result;
  }

  gpioRawOutputValue(index: number): boolean {
    const functionSelect = this.gpio[index].functionSelect;
    const mask = 1 << index;
    switch (functionSelect) {
      case FUNCTION_PWM:
        return !!(this.pwm.gpioValue & mask);
      case FUNCTION_SIO:
        return this.sio.getPinValue(index);
      case FUNCTION_PIO0:
        return this.pio[0].getPinValue(index);
      case FUNCTION_PIO1:
        return this.pio[1].getPinValue(index);
      case FUNCTION_PIO2:
        return this.pio[2].getPinValue(index);
      default:
        return false;
    }
  }

  gpioRawOutputEnable(index: number): boolean {
    const functionSelect = this.gpio[index].functionSelect;
    const mask = 1 << index;
    switch (functionSelect) {
      case FUNCTION_PWM:
        return !!(this.pwm.gpioDirection & mask);
      case FUNCTION_SIO:
        return this.sio.getOutputEnabled(index);
      case FUNCTION_PIO0:
        return this.pio[0].getPinOutputEnabled(index);
      case FUNCTION_PIO1:
        return this.pio[1].getPinOutputEnabled(index);
      case FUNCTION_PIO2:
        return this.pio[2].getPinOutputEnabled(index);
      default:
        return false;
    }
  }

  gpioInputValueHasBeenSet(index: number) {
    if (this.gpio[index].functionSelect === FUNCTION_PWM) {
      this.pwm.gpioOnInput(index);
    }
    for (const pio of this.pio) {
      for (const machine of pio.machines) {
        if (
          machine.enabled &&
          machine.waiting &&
          machine.waitType === WaitType.Pin &&
          machine.waitIndex === index
        ) {
          machine.checkWait();
        }
      }
    }
  }

  setInterrupt(irq: number, value: boolean) {
    // Use `this.core[i]`, not `this.core0`/`this.core1` — those are RISC-V-only
    // accessors that become dangerous concrete-pointer casts in the C build; on ARM
    // the array holds CortexM33Core, so calling CPU methods on them would corrupt memory.
    this.core[0].setInterrupt(irq, value);
    this.core[1].setInterrupt(irq, value);
  }

  setInterruptCore(irq: number, value: boolean, core: number) {
    this.core[core].setInterrupt(irq, value);
  }

  updateIOInterrupt() {
    let interruptValue = false;
    for (const pin of this.gpio) {
      if (pin.irqValue) {
        interruptValue = true;
      }
    }
    this.setInterrupt(IRQ2350.IO_IRQ_BANK0, interruptValue);
  }

  // The hottest function in the emulator: one call per core0 instruction. Both
  // branches are the same three steps, but written against the concrete core type —
  // `core[]` is ICpuCore[], and every access through it costs an indirect vtable call
  // the C compiler can't devirtualize (`cycles` isn't even reachable through the fat
  // pointer, hence getCycles()). Narrowing once on the construction-fixed `isArmCore`
  // makes executeInstruction()/executeInstructionsUpTo() direct calls and `cycles` a
  // plain field read; the branch itself is perfectly predicted.
  stepCores() {
    if (this.isArmCore) {
      const core0 = this.armCore0;
      this.currentCore = 0;
      const elapsed = core0.executeInstruction();
      this.currentCore = 1;
      // core0 doesn't execute again here, so its count is invariant for the catch-up.
      this.armCore1.executeInstructionsUpTo(core0.cycles);
      return elapsed;
    }
    const core0 = this.riscvCore0;
    this.currentCore = 0;
    const elapsed = core0.executeInstruction();
    this.currentCore = 1;
    this.riscvCore1.executeInstructionsUpTo(core0.cycles);
    return elapsed;
  }

  stepThings(cycles: number) {
    for (let cycle = 0; cycle < cycles; cycle++) {
      this.pio[0].step();
      this.pio[1].step();
      this.pio[2].step();
    }
    // Float64, not plain `number`: nanos-per-cycle is fractional for any clkSys that
    // doesn't divide 1e9 (150MHz → 6.667), and int32_t would truncate it, running the
    // whole simulated clock fast in the C build only.
    const cycleNanos: Float64 = 1e9 / this.clkSys;
    this.clock.tick(cycles * cycleNanos);
  }

  step() {
    this.stepThings(this.stepCores());
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  stop() {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  execute() {}
}
