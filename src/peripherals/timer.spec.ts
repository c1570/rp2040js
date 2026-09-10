import { describe, expect, it } from 'vitest';
import { RP2040 } from '../rp2040';

const ALARM0 = 0x40054010;
const ALARM1 = 0x40054014;
const ALARM2 = 0x40054018;
const ALARM3 = 0x4005401c;
const ARMED = 0x40054020;
const INTR = 0x40054034;
const INTR_CLEAR = INTR | 0x3000;
const INTE = 0x40054038;
const INTF = 0x4005403c;
const INTS = 0x40054040;

describe('RPTimer', () => {
  describe('Alarms', () => {
    it('should set Alarm 1 to armed when writing to ALARM1 register', () => {
      const rp2040 = new RP2040();
      rp2040.writeUint32(ALARM1, 0x1000);
      expect(rp2040.readUint32(ARMED)).toEqual(0x2);
    });

    it('should disarm Alarm 2 when writing 0x4 to the ARMED register', () => {
      const rp2040 = new RP2040();
      rp2040.writeUint32(ALARM2, 0x1000);
      expect(rp2040.readUint32(ARMED)).toEqual(0x4);
      rp2040.writeUint32(ARMED, 0xff);
      expect(rp2040.readUint32(ARMED)).toEqual(0);
    });

    it('should generate an IRQ 3 interrupt when Alarm 3 fires', () => {
      const rp2040 = new RP2040();
      // Arm the alarm
      rp2040.writeUint32(ALARM3, 1000);
      expect(rp2040.readUint32(ARMED)).toEqual(0x8);
      expect(rp2040.readUint32(INTR)).toEqual(0);
      // Advance time so that the alarm will fire
      rp2040.clock.tick(2000 * 1000);
      expect(rp2040.readUint32(ARMED)).toEqual(0);
      expect(rp2040.readUint32(INTR)).toEqual(0x8);
      expect(rp2040.readUint32(INTS)).toEqual(0);
      expect(rp2040.core0.pendingInterrupts).toBe(0);
      // Enable the interrupts for all alarms
      rp2040.writeUint32(INTE, 0xff);
      expect(rp2040.readUint32(INTS)).toEqual(0x8);
      expect(rp2040.core0.pendingInterrupts).toBe(0x8);
      expect(rp2040.core0.interruptsUpdated).toEqual(true);
      // Clear the alarm's interrupt
      rp2040.writeUint32(INTR_CLEAR, 0x8);
      expect(rp2040.readUint32(INTS)).toEqual(0);
      expect(rp2040.core0.pendingInterrupts).toBe(0);
    });

    it('fires an alarm scheduled more than INT32_MAX nanoseconds in the future', () => {
      const rp2040 = new RP2040();
      // Target 2.5 s ahead of the fresh clock: the nanosecond delta (2.5e9)
      // exceeds INT32_MAX, which overflows an int32 computation of the delta
      // (the alarm would fire immediately instead).
      rp2040.writeUint32(ALARM0, 2500000);
      rp2040.clock.tick(2_400_000_000);
      expect(rp2040.readUint32(INTR) & 0b1).toEqual(0);
      rp2040.clock.tick(200_000_000);
      expect(rp2040.readUint32(INTR) & 0b1).toEqual(0b1);
    });

    it('should generate an interrupt if INTF is 1 even when the INTE bit is 0', () => {
      const rp2040 = new RP2040();
      expect(rp2040.readUint32(INTS)).toEqual(0);
      expect(rp2040.readUint32(INTE)).toEqual(0);
      rp2040.writeUint32(INTF, 0x4);
      // The corresponding interrupt bit should be 1
      expect(rp2040.readUint32(INTS)).toEqual(0x4);
    });
  });
});
