import { ConsoleLogger, Logger, LogLevel } from '../utils/logging';
import { ICpuCore } from '../cpu-core';
import { IRPChip } from '../rpchip';
import { GDBConnection } from './gdb-connection';

const LOG_NAME = 'GDBServer';

export const STOP_REPLY_SIGINT = 'S02';

/**
 * Base class for GDB protocol servers.
 *
 * In addition to connection lifecycle, logging, and breakpoint notification,
 * this base hosts the shared execution/scheduling machinery that is identical
 * across the ARM (RP2040 Cortex-M0) and RISC-V (RP2350 Hazard3) servers. It is
 * typed over {@link ICpuCore} so the per-core fields collapse to a single
 * implementation regardless of architecture.
 *
 * Subclasses implement processGDBMessage() (protocol/register specifics) and
 * the readRegister/writeRegister hooks. The register model itself stays
 * per-architecture -- it is genuinely irreconcilable and each architecture
 * needs its own target.xml.
 */
export abstract class GDBServer {
  public logger: Logger = new ConsoleLogger(LogLevel.Warn, true);

  private readonly connections = new Set<GDBConnection>();

  // --- Shared execution/scheduling machinery (unified over ICpuCore) ---
  protected chip: IRPChip;
  /** Optional hook invoked by stop(); ARM uses it to forward to target.stop(). */
  protected readonly stopTarget?: () => void;
  protected executeTimer: ReturnType<typeof setTimeout> | null = null;
  protected stopped = true;
  protected currentThread = 1; // 1 = core0, 2 = core1
  protected haltedCore = 0;
  protected readonly breakpoints = new Set<number>();
  executing = false;
  // When set, only this core (0 or 1) is stepped during execute(). -1 = both.
  protected singleCore: number = -1;

  constructor(chip: IRPChip, stopTarget?: () => void) {
    this.chip = chip;
    this.stopTarget = stopTarget;
    this.onInterrupt = () => this.stop();
  }

  abstract processGDBMessage(cmd: string): string | void;

  /** Architecture-specific register read (register model is per-architecture). */
  protected abstract readRegister(index: number): number;
  /** Architecture-specific register write (register model is per-architecture). */
  protected abstract writeRegister(index: number, value: number): void;

  addConnection(connection: GDBConnection) {
    this.connections.add(connection);
  }

  removeConnection(connection: GDBConnection) {
    this.connections.delete(connection);
  }

  /** Called when a breakpoint/halt is hit during execution. */
  notifyBreakpoint(threadId: number = 1) {
    for (const connection of this.connections) {
      connection.onBreakpoint(threadId);
    }
  }

  /** Called when GDB sends Ctrl-C (interrupt). */
  onInterrupt?: () => void;

  execute() {
    this.stopped = false;
    this.executing = true;
    const run = () => {
      if (this.stopped) return;
      for (let i = 0; i < 100000 && !this.stopped; i++) {
        if (this.singleCore >= 0) {
          const core = this.chip.core[this.singleCore];
          this.chip.currentCore = this.singleCore;
          const elapsed = core.executeInstruction();
          if (this.singleCore === 0) this.chip.stepThings(elapsed);
          if (this.checkBreakpoints()) return;
        } else {
          if (this.stepLowestCycleCore()) return;
        }
      }
      if (!this.stopped) {
        this.executeTimer = setTimeout(run, 0);
      }
    };
    run();
  }

  stop() {
    this.stopped = true;
    this.executing = false;
    this.stopTarget?.();
    if (this.executeTimer != null) {
      clearTimeout(this.executeTimer);
      this.executeTimer = null;
    }
  }

  // Step whichever core has fewer cycles, then advance peripherals by the
  // core0 cycle delta only (core1 is catching up, not advancing wall-clock).
  protected stepLowestCycleCore(): boolean {
    const [core0, core1] = this.chip.core;
    this.chip.currentCore = core0.getCycles() <= core1.getCycles() ? 0 : 1;
    const core = this.chip.core[this.chip.currentCore];
    const elapsed = core.executeInstruction();
    if (this.chip.currentCore === 0) this.chip.stepThings(elapsed);
    return this.hitBreakpoint(core) ? this.halt(this.chip.currentCore) : false;
  }

  // A parked (WFI) core isn't executing, so its PC sitting on a breakpoint
  // address must not count as a hit (it would spuriously halt the session).
  protected hitBreakpoint(core: ICpuCore): boolean {
    return !core.waiting && this.breakpoints.has(core.PC);
  }

  protected halt(core: number): boolean {
    this.haltedCore = core;
    this.stopped = true;
    this.executing = false;
    this.singleCore = -1;
    this.notifyBreakpoint(core + 1);
    return true;
  }

  // Breakpoint check for the single-core continue path (vCont;c:N). The
  // both-cores path checks breakpoints itself, per instruction, in
  // stepLowestCycleCore.
  protected checkBreakpoints(): boolean {
    const core = this.chip.core[this.singleCore];
    if (this.hitBreakpoint(core)) {
      return this.halt(this.singleCore);
    }
    return false;
  }

  debug(msg: string) {
    this.logger.debug(LOG_NAME, msg);
  }

  info(msg: string) {
    this.logger.info(LOG_NAME, msg);
  }

  warn(msg: string) {
    this.logger.warn(LOG_NAME, msg);
  }

  error(msg: string) {
    this.logger.error(LOG_NAME, msg);
  }
}
