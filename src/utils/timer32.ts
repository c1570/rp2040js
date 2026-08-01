import { SimulationClock } from '../clock/simulation-clock';
import { AlarmCallback, IAlarm } from '../clock/clock';
import { Uint32, Float64 } from './types';

export enum TimerMode {
  Increment,
  Decrement,
  ZigZag,
}

export class Timer32 {
  private baseValue = 0;
  private baseNanos: Float64 = 0;
  private topValue: Uint32 = 0xffffffff;
  private prescalerValue = 1;
  private timerMode = TimerMode.Increment;
  private enabled = true;
  readonly listeners: AlarmCallback[] = [];

  constructor(readonly label: string, readonly clock: SimulationClock, private baseFreq: number) {}

  reset() {
    this.baseNanos = this.clock.nanos;
    this.baseValue = 0;
    this.updated();
  }

  set(value: number, zigZagDown = false) {
    this.baseValue = zigZagDown ? this.topValue * 2 - value : value;
    this.baseNanos = this.clock.nanos;
    this.updated();
  }

  /**
   * Advances the counter by the given amount. Note that this will
   * decrease the counter if the timer is running in Decrement mode.
   *
   * @param delta The value to add to the counter. Can be negative.
   */
  advance(delta: number) {
    this.baseValue += delta;
  }

  get rawCounter() {
    const { baseFreq, prescalerValue, baseNanos, baseValue, enabled, timerMode } = this;
    if (!baseFreq || !prescalerValue || !enabled) {
      return this.baseValue;
    }
    const zigzag = timerMode == TimerMode.ZigZag;
    const ticks = ((this.clock.nanos - baseNanos) / 1e9) * (baseFreq / prescalerValue);
    const topModulo = zigzag ? this.topValue * 2 : this.topValue + 1;
    // Guard against division by zero in the transpiled C build: `topModulo` wraps
    // to 0 when `topValue === 0xffffffff`, but remains nonzero in JS. This branch
    // is unreachable in JS execution; it exists only to prevent C division by zero.
    const delta =
      timerMode == TimerMode.Decrement
        ? topModulo === 0
          ? -ticks
          : topModulo - (ticks % topModulo)
        : ticks;
    let currentValue = Math.round(baseValue + delta);
    if (this.topValue != 0xffffffff) {
      currentValue %= topModulo;
    }
    return currentValue;
  }

  get counter() {
    let currentValue = this.rawCounter;
    if (this.timerMode == TimerMode.ZigZag && currentValue > this.topValue) {
      currentValue = this.topValue * 2 - currentValue;
    }
    return currentValue >>> 0;
  }

  get top(): Uint32 {
    return this.topValue;
  }

  set top(value: Uint32) {
    const { counter } = this;
    this.topValue = value;
    this.set(counter <= this.topValue ? counter : 0);
  }

  get frequency() {
    return this.baseFreq;
  }

  set frequency(value: number) {
    this.baseValue = this.counter;
    this.baseNanos = this.clock.nanos;
    this.baseFreq = value;
    this.updated();
  }

  get prescaler() {
    return this.prescalerValue;
  }

  set prescaler(value: number) {
    this.baseValue = this.counter;
    this.baseNanos = this.clock.nanos;
    this.enabled = this.prescalerValue !== 0;
    this.prescalerValue = value;
    this.updated();
  }

  // Uint32 param: int32_t would reinterpret cycles >= 2**31 as negative. Float64
  // return: the result isn't always a whole number, and can exceed int32 range.
  // nanosPerCycle explicitly Float64 too (a real double in C, not an int32_t
  // literal): `cycles * nanosPerCycle` then promotes to double via C's usual
  // arithmetic conversions, matching JS's double math exactly — `cycles * 1e9`
  // directly would multiply as native 32-bit integers first and overflow.
  toNanos(cycles: Uint32): Float64 {
    const { baseFreq, prescalerValue } = this;
    const nanosPerCycle: Float64 = 1e9 / (baseFreq / prescalerValue);
    return cycles * nanosPerCycle;
  }

  get enable() {
    return this.enabled;
  }

  set enable(value: boolean) {
    if (value !== this.enabled) {
      if (value) {
        this.baseNanos = this.clock.nanos;
      } else {
        this.baseValue = this.counter;
      }
      this.enabled = value;
      this.updated();
    }
  }

  get mode() {
    return this.timerMode;
  }

  set mode(value: TimerMode) {
    if (this.timerMode !== value) {
      const { counter } = this;
      this.timerMode = value;
      this.set(counter);
    }
  }

  private updated() {
    for (const listener of this.listeners) {
      listener.fire();
    }
  }
}

/** Re-schedules a Timer32PeriodicAlarm when its underlying Timer32 changes (reset,
 * frequency/prescaler/mode change, etc.) — a separate AlarmCallback identity from the
 * alarm's own `fire()` (the alarm firing) since they're different events. */
class Timer32PeriodicAlarmUpdateListener implements AlarmCallback {
  constructor(private readonly alarm: Timer32PeriodicAlarm) {}
  fire() {
    this.alarm.onTimerUpdated();
  }
}

export class Timer32PeriodicAlarm implements AlarmCallback {
  private targetValue = 0;
  private enabled = false;
  private clockAlarm: IAlarm;
  private warnedZeroInterval = false;

  constructor(readonly label: string, readonly timer: Timer32, readonly callback: AlarmCallback) {
    this.clockAlarm = this.timer.clock.createAlarm(this);
    timer.listeners.push(new Timer32PeriodicAlarmUpdateListener(this));
  }

  get enable() {
    return this.enabled;
  }

  set enable(value: boolean) {
    if (value !== this.enabled) {
      this.enabled = value;
      if (value && this.timer.enable) {
        this.schedule();
      } else {
        this.cancel();
      }
    }
  }

  get target() {
    return this.targetValue;
  }

  set target(value: number) {
    if (value === this.targetValue) {
      return;
    }
    this.targetValue = value;
    if (this.enabled && this.timer.enable) {
      this.cancel();
      this.schedule();
    }
  }

  fire() {
    this.callback.fire();
    if (this.enabled && this.timer.enable) {
      this.schedule();
    }
  }

  onTimerUpdated() {
    this.cancel();
    if (this.enabled && this.timer.enable) {
      this.schedule();
    }
  }

  private schedule() {
    const { timer, targetValue } = this;
    const { top, mode, rawCounter } = timer;
    // Uint32 type: int32_t would wrap unsigned differences back to negative
    // on assignment, breaking the unbounded-timer (top=0xffffffff) branch.
    let cycleDelta: Uint32;
    if (mode === TimerMode.ZigZag) {
      // A phase-correct counter crosses the target twice per 2*top period,
      // once per slope; schedule whichever crossing comes first. A distance
      // of 0 means "firing right now" and wraps to the next crossing.
      const period = top * 2 || 1;
      const distance = (crossing: number) => {
        const d = (crossing - rawCounter) % period;
        return d <= 0 ? d + period : d;
      };
      cycleDelta = Math.min(distance(targetValue), distance(period - targetValue));
    } else {
      // Delta in the counter's own direction of travel. rawCounter is
      // unwrapped for full-width (top=0xffffffff) timers and biased +period
      // in Decrement mode, so the raw delta can be off by whole periods in
      // either direction; normalize with a Euclidean modulo (a `>>> 0` just
      // reinterprets the sign bit). A delta of 0 (already at target) means a
      // full period, not a 0ns refire loop.
      cycleDelta =
        mode === TimerMode.Decrement ? rawCounter - targetValue : targetValue - rawCounter;
      // Unbounded timer (top=0xffffffff): `period` wraps to 0 in C but is 2**32 in JS.
      // Use `>>> 0` to reinterpret as unsigned (Euclidean modulo 2**32), avoiding the
      // zero-division issue that would leave cycleDelta unnormalized and negative.
      if (top === 0xffffffff) {
        cycleDelta = cycleDelta >>> 0;
        if (cycleDelta === 0) {
          // Already at target: use one cycle short of a full period (0xffffffff)
          // since 2**32 doesn't fit in any 32-bit C type.
          cycleDelta = 0xffffffff;
        }
      } else {
        const period = top + 1;
        cycleDelta = ((cycleDelta % period) + period) % period;
        if (cycleDelta === 0) {
          cycleDelta = period;
        }
      }
    }
    if (targetValue > top) {
      // Skip alarm
      return;
    }
    // Uint32 type: bare `const x = cycleDelta` would re-infer int32_t in C,
    // wrapping values >= 2**31 back to negative.
    const cyclesToAlarm: Uint32 = cycleDelta;
    const nanosToAlarm: Float64 = timer.toNanos(cyclesToAlarm);
    if (nanosToAlarm <= 0 && !this.warnedZeroInterval) {
      this.warnedZeroInterval = true;
      console.warn(
        `Timer32PeriodicAlarm(${this.label}): scheduling with a ${nanosToAlarm}ns interval (target=${targetValue}, rawCounter=${rawCounter}); this may cause an infinite reschedule loop`
      );
    }
    this.clockAlarm.schedule(nanosToAlarm);
  }

  private cancel() {
    this.clockAlarm.cancel();
  }
}
