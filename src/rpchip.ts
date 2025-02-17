import { GPIOPin } from './gpio-pin';
import { IClock } from './clock/clock';
import { Logger } from './utils/logging';

export interface IRPChip {
  readonly identifier: string; // "rp2040" or "rp2350"

  logger: Logger;
  loadBootrom(bootromData: Uint32Array): void;
  readonly disassembly: string;
  loadDisassembly(dis: string): void;

  readonly qspi: Array<GPIOPin>;
  readonly gpio: Array<GPIOPin>;
  gpioValues(start_index: number): number;
  gpioRawOutputValue(index: number): boolean;
  gpioRawOutputEnable(index: number): boolean;
  gpioInputValueHasBeenSet(index: number): void;

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
