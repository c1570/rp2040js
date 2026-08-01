import { Int53 } from './utils/types';

/** Shared execution/scheduling surface for Cortex-M0, RISC-V (Hazard3), and Cortex-M33 cores. */
export interface ICpuCore {
  /** Core index (0/1). */
  readonly coreIndex: number;
  cycles: Int53; // avoids int32_t overflow past ~2.15B cycles
  PC: number;
  waiting: boolean;
  eventRegistered: boolean;
  interruptsUpdated: boolean;
  otherCore: ICpuCore;
  /**
   * Accessor methods for `cycles`, used only by cross-core reads/writes through an
   * ICpuCore-typed value — own-field access (`this.cycles++`) still transpiles as a
   * plain struct field; only the interface-typed case needs a dispatchable method,
   * since cts2c can't read/write a field through an opaque interface fat pointer
   * (same reasoning as `Peripheral.byteAddressable()`).
   */
  getCycles(): Int53;
  addCycles(delta: number): void;
  /**
   * Setter for `otherCore`, used only for cross-core wiring through an ICpuCore-typed
   * value — same reasoning as getCycles()/addCycles(): an interface property assignment
   * through an opaque fat pointer has no C equivalent, so it needs a dispatchable
   * method. Each class's own `otherCore` field keeps its concrete type for internal use.
   */
  setOtherCore(other: ICpuCore): void;
  executeInstruction(): number;
  /**
   * Runs instructions until `cycles >= cycle`. Keeping the catch-up loop inside the
   * core turns each iteration's `cycles` read and `executeInstruction()` call into a
   * plain field access and a direct (inlinable) call, instead of two indirect
   * ICpuCore vtable calls. It also lets a core that's parked in WFI/WFE jump its
   * counter straight to the target in O(1) rather than ticking one cycle at a time.
   */
  executeInstructionsUpTo(cycle: Int53): void;
  reset(): void;
  fireSEV(): void;
  setInterrupt(irq: number, value: boolean): void;
}
