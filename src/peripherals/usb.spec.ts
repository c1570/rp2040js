import { describe, expect, it } from 'vitest';
import { RP2040 } from '..';

// Register offsets (mirrors the private consts in usb.ts).
const BUFF_STATUS = 0x58;
const EP0_IN_BUFFER_CONTROL = 0x80;

const USB_BUF_CTRL_AVAILABLE = 1 << 10;

describe('USB', () => {
  it('delivers a single scheduled read completion into DPRAM', () => {
    const cpu = new RP2040();
    const buffer = new Uint8Array([1, 2, 3, 4]);

    // EP0's OUT buffer-control register (offset EP0_OUT_BUFFER_CONTROL === 0x84)
    // holds the requested transfer length in its low bits — finishRead() clamps
    // the delivered buffer to it.
    cpu.usbDPRAMView.setUint32(0x84, 4, true);

    cpu.usbCtrl.endpointReadDone(0, buffer, 4, 1);
    cpu.clock.tick(2000); // > 1us delay, fires the read alarm

    expect(Array.from(cpu.usbDPRAM.slice(0x100, 0x104))).toEqual([1, 2, 3, 4]);
    // indicateBufferReady(0, true) sets bit (0*2 + 1) = bit 1 of BUFF_STATUS.
    expect(cpu.usbCtrl.readUint32(BUFF_STATUS) & 0b10).toBe(0b10);
  });

  it('preserves FIFO order across multiple pending read completions', () => {
    const cpu = new RP2040();
    cpu.usbDPRAMView.setUint32(0x84, 4, true);

    const bufA = new Uint8Array([1, 2, 3, 4]);
    const bufB = new Uint8Array([5, 6, 7, 8]);

    // Both scheduled before the alarm fires — schedule() reschedules the same
    // alarm, so only one fire() per tick, delivering just the front of the queue.
    cpu.usbCtrl.endpointReadDone(0, bufA, 4, 1);
    cpu.usbCtrl.endpointReadDone(0, bufB, 4, 1);

    cpu.clock.tick(2000);
    expect(Array.from(cpu.usbDPRAM.slice(0x100, 0x104))).toEqual([1, 2, 3, 4]);

    // bufB is still queued behind the drained bufA — scheduling a third buffer
    // reschedules the alarm and drains bufB (not the newly-scheduled bufC),
    // confirming FIFO order (not LIFO).
    const bufC = new Uint8Array([9, 9, 9, 9]);
    cpu.usbCtrl.endpointReadDone(0, bufC, 4, 1);
    cpu.clock.tick(2000);
    expect(Array.from(cpu.usbDPRAM.slice(0x100, 0x104))).toEqual([5, 6, 7, 8]);

    // bufC only drains once something schedules (and thus fires) the alarm again.
    cpu.usbCtrl.endpointReadDone(0, new Uint8Array([0, 0, 0, 0]), 4, 1);
    cpu.clock.tick(2000);
    expect(Array.from(cpu.usbDPRAM.slice(0x100, 0x104))).toEqual([9, 9, 9, 9]);
  });

  it('throws instead of silently dropping data when the pending-buffer queue overflows', () => {
    const cpu = new RP2040();
    const buffer = new Uint8Array([0]);

    // Every call reschedules the same alarm without ever firing it, so the
    // queue just grows — 9 calls exceeds the fixed capacity (8).
    expect(() => {
      for (let i = 0; i < 9; i++) {
        cpu.usbCtrl.endpointReadDone(0, buffer, 4, 1);
      }
    }).toThrow(/pending buffer queue full/);
  });

  it('delivers a single scheduled write completion via onEndpointWrite', () => {
    const cpu = new RP2040();
    const delivered: Array<{ endpoint: number; data: number[] }> = [];
    cpu.usbCtrl.onEndpointWrite = (endpoint, data, length) => {
      delivered.push({ endpoint, data: Array.from(data.subarray(0, length)) });
    };

    // Data the device "wrote" into its IN buffer, ready for the host to pick up.
    cpu.usbDPRAM.set([10, 20, 30, 40], 0x100);

    // Writing the IN buffer-control register with AVAILABLE set (and endpoint 0,
    // so non-double-buffered) triggers DPRAMUpdated's write-completion path,
    // which schedules the write alarm.
    cpu.writeUint32(0x50100000 + EP0_IN_BUFFER_CONTROL, 4 | USB_BUF_CTRL_AVAILABLE);
    cpu.clock.tick(20000); // > writeDelayMicroseconds (10us) default

    expect(delivered).toEqual([{ endpoint: 0, data: [10, 20, 30, 40] }]);
  });

  it('delivers multiple queued write completions in order on a single fire', () => {
    const cpu = new RP2040();
    const delivered: number[][] = [];
    cpu.usbCtrl.onEndpointWrite = (_endpoint, data, length) => {
      delivered.push(Array.from(data.subarray(0, length)));
    };

    cpu.usbDPRAM.set([1, 1, 1, 1], 0x100);
    cpu.writeUint32(0x50100000 + EP0_IN_BUFFER_CONTROL, 4 | USB_BUF_CTRL_AVAILABLE);

    cpu.usbDPRAM.set([2, 2, 2, 2], 0x100);
    cpu.writeUint32(0x50100000 + EP0_IN_BUFFER_CONTROL, 4 | USB_BUF_CTRL_AVAILABLE);

    cpu.clock.tick(20000);

    expect(delivered).toEqual([
      [1, 1, 1, 1],
      [2, 2, 2, 2],
    ]);
  });
});
