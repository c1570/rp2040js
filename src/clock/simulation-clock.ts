import { AlarmCallback, IAlarm, IClock } from './clock.js';
import { Float64 } from '../utils/types';

export class ClockAlarm implements IAlarm {
  next: ClockAlarm | null = null;
  nanos: Float64 = 0;
  scheduled = false;

  constructor(private readonly clock: SimulationClock, readonly callback: AlarmCallback) {}

  schedule(deltaNanos: Float64): void {
    if (this.scheduled) {
      this.cancel();
    }
    this.clock.linkAlarm(deltaNanos, this);
  }

  cancel(): void {
    this.clock.unlinkAlarm(this);
    this.scheduled = false;
  }
}

export class SimulationClock implements IClock {
  private nextAlarm: ClockAlarm | null = null;

  // Float64 (not `number`): a nanosecond counter as plain `number` compiles to C
  // `int32_t`, overflowing after ~2.15s of simulated uptime. Float64 emits
  // `double`, matching JS's actual runtime type exactly (no truncation).
  private nanosCounter: Float64 = 0;

  constructor(readonly frequency = 125e6) {}

  get nanos(): Float64 {
    return this.nanosCounter;
  }

  getNanos(): Float64 {
    return this.nanosCounter;
  }

  get micros(): Float64 {
    return this.nanos / 1000;
  }

  createAlarm(callback: AlarmCallback): IAlarm {
    return new ClockAlarm(this, callback);
  }

  linkAlarm(nanos: Float64, alarm: ClockAlarm) {
    alarm.nanos = this.nanos + nanos;
    let alarmListItem = this.nextAlarm;
    let lastItem = null;
    while (alarmListItem && alarmListItem.nanos < alarm.nanos) {
      lastItem = alarmListItem;
      alarmListItem = alarmListItem.next;
    }
    if (lastItem) {
      lastItem.next = alarm;
      alarm.next = alarmListItem;
    } else {
      this.nextAlarm = alarm;
      alarm.next = alarmListItem;
    }
    alarm.scheduled = true;
    return alarm;
  }

  unlinkAlarm(alarm: ClockAlarm) {
    let alarmListItem = this.nextAlarm;
    if (!alarmListItem) {
      return false;
    }
    let lastItem = null;
    while (alarmListItem) {
      if (alarmListItem === alarm) {
        if (lastItem) {
          lastItem.next = alarmListItem.next;
        } else {
          this.nextAlarm = alarmListItem.next;
        }
        return true;
      }
      lastItem = alarmListItem;
      alarmListItem = alarmListItem.next;
    }
    return false;
  }

  tick(deltaNanos: Float64) {
    const targetNanos: Float64 = this.nanosCounter + deltaNanos;
    let alarm = this.nextAlarm;
    while (alarm && alarm.nanos <= targetNanos) {
      this.nextAlarm = alarm.next;
      this.nanosCounter = alarm.nanos;
      alarm.callback.fire();
      alarm = this.nextAlarm;
    }
    this.nanosCounter = targetNanos;
  }

  get nanosToNextAlarm(): Float64 {
    if (this.nextAlarm) {
      return this.nextAlarm.nanos - this.nanos;
    }
    return 0;
  }
}
