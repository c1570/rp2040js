import { IRPChip } from './rpchip';

export enum GPIOPinState {
  Low,
  High,
  Input,
  InputPullUp,
  InputPullDown,
}

export const FUNCTION_PWM = 4;
export const FUNCTION_SIO = 5;
export const FUNCTION_PIO0 = 6;
export const FUNCTION_PIO1 = 7;
export const FUNCTION_PIO2 = 8;

export type GPIOPinListener = (state: GPIOPinState, oldState: GPIOPinState) => void;

function applyOverride(value: boolean, overrideType: number) {
  switch (overrideType) {
    case 0:
      return value;
    case 1:
      return !value;
    case 2:
      return false;
    case 3:
      return true;
  }
  console.error('applyOverride received invalid override type', overrideType);
  return value;
}

const IRQ_EDGE_HIGH = 1 << 3;
const IRQ_EDGE_LOW = 1 << 2;
const IRQ_LEVEL_HIGH = 1 << 1;
const IRQ_LEVEL_LOW = 1 << 0;

export class GPIOPin {
  private rawInputValue = false;
  private lastValue = GPIOPinState.Input;

  ctrl: number = 0x1f;
  padValue: number = 0b0110110;
  irqEnableMask = 0;
  irqForceMask = 0;
  irqStatus = 0;

  private readonly listeners = new Set<GPIOPinListener>();

  constructor(readonly rp2040: IRPChip, readonly index: number, readonly name = index.toString()) {}

  get rawInterrupt() {
    return !!((this.irqStatus & this.irqEnableMask) | this.irqForceMask);
  }

  get isSlewFast() {
    return !!(this.padValue & 1);
  }

  get schmittEnabled() {
    return !!(this.padValue & 2);
  }

  get pulldownEnabled() {
    return !!(this.padValue & 4);
  }

  get pullupEnabled() {
    return !!(this.padValue & 8);
  }

  get driveStrength() {
    return (this.padValue >> 4) & 0x3;
  }

  get inputEnable() {
    return !!(this.padValue & 0x40);
  }

  get outputDisable() {
    return !!(this.padValue & 0x80);
  }

  get functionSelect() {
    return this.ctrl & 0x1f;
  }

  get outputOverride() {
    return (this.ctrl >> 8) & 0x3;
  }

  get outputEnableOverride() {
    return (this.ctrl >> 12) & 0x3;
  }

  get inputOverride() {
    return (this.ctrl >> 16) & 0x3;
  }

  get irqOverride() {
    return (this.ctrl >> 28) & 0x3;
  }

  get inputValue() {
    return applyOverride(this.rawInputValue && this.inputEnable, this.inputOverride);
  }

  get irqValue() {
    return applyOverride(this.rawInterrupt, this.irqOverride);
  }

  get outputEnable() {
    return applyOverride(this.rp2040.gpioRawOutputEnable(this.index), this.outputEnableOverride);
  }

  get outputValue() {
    return applyOverride(this.rp2040.gpioRawOutputValue(this.index), this.outputOverride);
  }

  /**
   * Returns the STATUS register value for the pin, as outlined in section 2.19.6 of the datasheet
   */
  get status() {
    const irqToProc = this.irqValue ? 1 << 26 : 0;
    const irqFromPad = this.rawInterrupt ? 1 << 24 : 0;
    const inToPeri = this.inputValue ? 1 << 19 : 0;
    const inFromPad = this.rawInputValue ? 1 << 17 : 0;
    const oeToPad = this.outputEnable ? 1 << 13 : 0;
    const oeFromPeri = this.rp2040.gpioRawOutputEnable(this.index) ? 1 << 12 : 0;
    const outToPad = this.outputValue ? 1 << 9 : 0;
    const outFromPeri = this.rp2040.gpioRawOutputValue(this.index) ? 1 << 8 : 0;
    return (
      irqToProc | irqFromPad | inToPeri | inFromPad | oeToPad | oeFromPeri | outToPad | outFromPeri
    );
  }

  get value() {
    if (this.outputEnable) {
      return this.outputValue ? GPIOPinState.High : GPIOPinState.Low;
    } else {
      // TODO: check what happens when we enable both pullup/pulldown
      if (this.pulldownEnabled) {
        return GPIOPinState.InputPullDown;
      }
      if (this.pullupEnabled) {
        return GPIOPinState.InputPullUp;
      }
      return GPIOPinState.Input;
    }
  }

  setInputValue(value: boolean) {
    this.rawInputValue = value;
    const prevIrqValue = this.irqValue;
    if (value && this.inputEnable) {
      this.irqStatus |= IRQ_EDGE_HIGH | IRQ_LEVEL_HIGH;
      this.irqStatus &= ~IRQ_LEVEL_LOW;
    } else {
      this.irqStatus |= IRQ_EDGE_LOW | IRQ_LEVEL_LOW;
      this.irqStatus &= ~IRQ_LEVEL_HIGH;
    }
    if (this.irqValue !== prevIrqValue) {
      this.rp2040.updateIOInterrupt();
    }
    this.rp2040.gpioInputValueHasBeenSet(this.index);
  }

  checkForUpdates() {
    const { lastValue, value } = this;
    if (value !== lastValue) {
      this.lastValue = value;
      for (const listener of this.listeners) {
        listener(value, lastValue);
      }
    }
  }

  refreshInput() {
    this.setInputValue(this.rawInputValue);
  }

  updateIRQValue(value: number) {
    if (value & IRQ_EDGE_LOW && this.irqStatus & IRQ_EDGE_LOW) {
      this.irqStatus &= ~IRQ_EDGE_LOW;
      this.rp2040.updateIOInterrupt();
    }
    if (value & IRQ_EDGE_HIGH && this.irqStatus & IRQ_EDGE_HIGH) {
      this.irqStatus &= ~IRQ_EDGE_HIGH;
      this.rp2040.updateIOInterrupt();
    }
  }

  addListener(callback: GPIOPinListener) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}
