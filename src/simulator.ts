import { IGDBTarget } from './gdb/gdb-target';
import { IRPChip } from './rpchip';

export class Simulator<ChipType extends IRPChip = IRPChip> implements IGDBTarget<ChipType> {
  executeTimer: ReturnType<typeof setTimeout> | null = null;
  rpchip: ChipType;
  stopped = true;

  constructor(rpchip: ChipType) {
    this.rpchip = rpchip;
  }

  execute() {
    this.executeTimer = null;
    this.stopped = false;
    for (let i = 0; i < 1000000 && !this.stopped; i++) {
      this.rpchip.step();
    }
    if (!this.stopped) {
      this.executeTimer = setTimeout(() => this.execute(), 0);
    }
  }

  stop() {
    this.stopped = true;
    if (this.executeTimer != null) {
      clearTimeout(this.executeTimer);
      this.executeTimer = null;
    }
  }

  get executing() {
    return !this.stopped;
  }
}
