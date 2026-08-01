import { Float64 } from '../utils/types';

/**
 * A fired-alarm handler. An interface (not `() => void`) because cts2c targets C,
 * which has function pointers but no closures — an interface transpiles to ordinary
 * vtable dispatch. Classes with one alarm implement this directly; those with several
 * use a small per-alarm adapter class.
 */
export interface AlarmCallback {
  fire(): void;
}

export interface IAlarm {
  schedule(deltaNanos: Float64): void;
  cancel(): void;
}

export interface IClock {
  readonly nanos: Float64;

  // Method form of the `nanos` getter: cts2c can't transpile interface property
  // access, only method calls — reading `nanos` through an IClock reference must
  // use getNanos(), else it silently transpiles to a stubbed 0.
  getNanos(): Float64;

  createAlarm(callback: AlarmCallback): IAlarm;
  tick(nanos: Float64): void;
}
