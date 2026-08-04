import { GPIOPin } from './gpio-pin';
import { IClock } from './clock/clock';
import { ICpuCore } from './cpu-core';
import { Logger } from './utils/logging';
import { RPPIO } from './peripherals/pio';

export interface IRPChip {
  readonly identifier: string; // "rp2040" or "rp2350"

  logger: Logger;
  loadBootrom(bootromData: Uint32Array): void;
  readonly disassembly: string;
  loadDisassembly(dis: string): void;
  onTrace(coreNumber: number, pc: number, tag: string): void;

  /** CPU cores; core[0] == core0, core[1] == core1. */
  readonly core: ICpuCore[];
  /** Index (0/1) of the core currently executing — selects SIO/PPB core view. */
  currentCore: number;

  readonly qspi: Array<GPIOPin>;
  readonly gpio: Array<GPIOPin>;
  gpioValues(start_index: number): number;
  gpioRawOutputValue(index: number): boolean;
  gpioRawOutputEnable(index: number): boolean;
  gpioInputValueHasBeenSet(index: number): void;
  /** Called when a PIO state machine is enabled or disabled. */
  updatePioActiveLists(): void;

  readonly pio: Array<RPPIO>;

  readonly flash: Uint8Array;
  readonly sram: Uint8Array;

  readonly usbDPRAM: Uint8Array;
  readonly usbDPRAMView: DataView;

  readonly cycles: number;
  readonly clkSys: number;
  readonly clkPeri: number;

  readUint32(address: number): number;
  readUint16(address: number): number;
  readUint8(address: number): number;
  writeUint32(address: number, value: number): void;
  writeUint8(address: number, value: number): void;
  writeUint16(address: number, value: number): void;

  dma_clearDREQ(dreq: number): void;
  dma_setDREQ(dreq: number): void;
  clock: IClock;

  reset(): void;
  setInterrupt(irq: number, value: boolean): void;
  setInterruptCore(irq: number, value: boolean, core: number): void;
  updateIOInterrupt(): void;

  stepCores(): void;
  stepThings(cycles: number): void;
  step(): void;
}
