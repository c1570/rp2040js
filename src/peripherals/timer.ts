import { AlarmCallback, IClock, IAlarm } from '../clock/clock';
import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';
import { Float64 } from '../utils/types';

const TIMEHR = 0x08;
const TIMELR = 0x0c;
const TIMERAWH = 0x24;
const TIMERAWL = 0x28;
const ALARM0 = 0x10;
const ALARM1 = 0x14;
const ALARM2 = 0x18;
const ALARM3 = 0x1c;
const ARMED = 0x20;
const PAUSE = 0x30;

const ALARM_0 = 1 << 0;
const ALARM_1 = 1 << 1;
const ALARM_2 = 1 << 2;
const ALARM_3 = 1 << 3;

class RPTimerAlarm implements AlarmCallback {
  armed = false;
  targetMicros = 0;
  clockAlarm!: IAlarm;

  constructor(private readonly timer: RPTimer, readonly bitValue: number, readonly index: number) {}

  fire() {
    this.timer.fireAlarm(this.index);
  }
}

export class RPTimer<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private readonly clock: IClock;
  private latchedTimeHigh = 0;
  private readonly alarms: RPTimerAlarm[];
  private intRaw = 0;
  private intEnable = 0;
  private intForce = 0;
  private paused = false;
  private INTR = 0;
  private INTE = 0;
  private INTF = 0;
  private INTS = 0;

  constructor(rp2040: ChipType, name: string, readonly timer_irq_base: number) {
    super(rp2040, name);
    this.clock = rp2040.clock;
    switch (rp2040.identifier) {
      case 'rp2040':
        this.INTR = 0x34;
        this.INTE = 0x38;
        this.INTF = 0x3c;
        this.INTS = 0x40;
        break;
      case 'rp2350':
        this.INTR = 0x3c;
        this.INTE = 0x40;
        this.INTF = 0x44;
        this.INTS = 0x48;
        break;
      default:
        throw Error('Unknown rpchip identifier');
    }
    this.alarms = [
      new RPTimerAlarm(this, ALARM_0, 0),
      new RPTimerAlarm(this, ALARM_1, 1),
      new RPTimerAlarm(this, ALARM_2, 2),
      new RPTimerAlarm(this, ALARM_3, 3),
    ];
    for (const alarm of this.alarms) {
      alarm.clockAlarm = this.clock.createAlarm(alarm);
    }
  }

  get intStatus() {
    return (this.intRaw & this.intEnable) | this.intForce;
  }

  readUint32(offset: number) {
    // `time` (µs since boot) is computed only in the cases that need it
    // (TIMELR/TIMERAWH/TIMERAWL; TIMEHR returns the value latched by a prior TIMELR),
    // not up front — reading it costs a division against the nanosecond counter, and
    // most reads here (ALARM*/PAUSE/INTR-INTS/ARMED) never need it.
    switch (offset) {
      case TIMEHR:
        return this.latchedTimeHigh;

      case TIMELR: {
        const time: Float64 = this.clock.getNanos() / 1000;
        this.latchedTimeHigh = Math.floor(time / 2 ** 32);
        return time >>> 0;
      }

      case TIMERAWH: {
        const time: Float64 = this.clock.getNanos() / 1000;
        return Math.floor(time / 2 ** 32);
      }

      case TIMERAWL: {
        const time: Float64 = this.clock.getNanos() / 1000;
        return time >>> 0;
      }

      case ALARM0:
        return this.alarms[0].targetMicros;
      case ALARM1:
        return this.alarms[1].targetMicros;
      case ALARM2:
        return this.alarms[2].targetMicros;
      case ALARM3:
        return this.alarms[3].targetMicros;

      case PAUSE:
        return this.paused ? 1 : 0;

      case this.INTR:
        return this.intRaw;
      case this.INTE:
        return this.intEnable;
      case this.INTF:
        return this.intForce;
      case this.INTS:
        return this.intStatus;

      case ARMED:
        return (
          (this.alarms[0].armed ? this.alarms[0].bitValue : 0) |
          (this.alarms[1].armed ? this.alarms[1].bitValue : 0) |
          (this.alarms[2].armed ? this.alarms[2].bitValue : 0) |
          (this.alarms[3].armed ? this.alarms[3].bitValue : 0)
        );
    }
    return super.readUint32(offset);
  }

  writeUint32(offset: number, value: number) {
    switch (offset) {
      case ALARM0:
      case ALARM1:
      case ALARM2:
      case ALARM3: {
        const alarmIndex = (offset - ALARM0) / 4;
        const alarm = this.alarms[alarmIndex];
        const deltaMicros = (value - this.clock.getNanos() / 1000) >>> 0;
        alarm.armed = true;
        alarm.targetMicros = value;
        alarm.clockAlarm.schedule(deltaMicros * 1000);
        break;
      }
      case ARMED:
        for (const alarm of this.alarms) {
          if (this.rawWriteValue & alarm.bitValue) {
            this.disarmAlarm(alarm);
          }
        }
        break;
      case PAUSE:
        this.paused = !!(value & 1);
        if (this.paused) {
          this.warn('Unimplemented Timer Pause');
        }
        // TODO actually pause the timer
        break;
      case this.INTR:
        this.intRaw &= ~this.rawWriteValue;
        this.checkInterrupts();
        break;
      case this.INTE:
        this.intEnable = value & 0xf;
        this.checkInterrupts();
        break;
      case this.INTF:
        this.intForce = value & 0xf;
        this.checkInterrupts();
        break;
      default:
        super.writeUint32(offset, value);
    }
  }

  fireAlarm(index: number) {
    const alarm = this.alarms[index];
    this.disarmAlarm(alarm);
    this.intRaw |= alarm.bitValue;
    this.checkInterrupts();
  }

  private checkInterrupts() {
    const { intStatus } = this;
    for (let i = 0; i < this.alarms.length; i++) {
      this.rp2040.setInterrupt(this.timer_irq_base + i, !!(intStatus & (1 << i)));
    }
  }

  private disarmAlarm(alarm: RPTimerAlarm) {
    alarm.clockAlarm.cancel();
    alarm.armed = false;
  }
}
