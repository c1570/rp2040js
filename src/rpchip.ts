import { GPIOPin } from './gpio-pin';
import { IClock } from './clock/clock';

export interface IRPChip {
  readonly identifier: string; // "rp2040" or "rp2350"

  public logger: Logger;
  loadBootrom(bootromData: Uint32Array);
  readonly disassembly: string;
  loadDisassembly(dis: string);

  readonly qspi: Array<GPIOPin>;
  readonly gpio: Array<GPIOPin>;
  readonly gpioValues: number;
  gpioRawOutputValue(functionSelect: number): number;
  gpioRawOutputEnable(functionSelect: number): number;
  gpioInputValueHasBeenSet(index: number);

  readonly usbDPRAM: Uint8Array;
  readonly usbDPRAMView: DataView;

  readonly cycles: number;
  readonly clkSys: number;
  readonly clkPeri: number;

  readUint32(address: number): number;
  readUint16(address: number): number;
  readUint8(address: number): number;
  writeUint32(address: number, value: number);
  writeUint8(address: number, value: number);
  writeUint16(address: number, value: number);

  dma_clearDREQ(dreq: number);
  dma_setDREQ(dreq: number);
  clock: IClock;

  reset();
  setInterrupt(irq: number, value: boolean);
  setInterruptCore(irq: number, value: boolean, core: number);
  updateIOInterrupt();
  stepCores();
  stepPios(cycles: number);
  step();
}
