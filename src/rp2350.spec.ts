import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { BasePeripheral } from './peripherals/peripheral';
import { RP2350 } from './rp2350';
import { bootrom_rp2350_A2 } from './bootroms';
import { loadHex } from './utils/load-hex';
import { GPIOPinState } from '../src/gpio-pin';
import { IRQ2350 } from './irq_rp2350';

describe('RP2350', () => {
  describe('IO Register Writes', () => {
    it('should replicate 8-bit values four times', () => {
      const rp2350 = new RP2350();
      const testPeripheral = new BasePeripheral(rp2350, 'TestPeripheral');
      const writeUint32 = vi.spyOn(testPeripheral, 'writeUint32');
      rp2350.peripherals[0x10] = testPeripheral;
      rp2350.writeUint8(0x10123, 0x534);
      expect(writeUint32).toHaveBeenCalledWith(0x120, 0x34343434);
    });

    it('should replicate 16-bit values twice', () => {
      const rp2350 = new RP2350();
      const testPeripheral = new BasePeripheral(rp2350, 'TestPeripheral');
      const writeUint32 = vi.spyOn(testPeripheral, 'writeUint32');
      rp2350.peripherals[0x10] = testPeripheral;
      rp2350.writeUint16(0x10123, 0x12345678);
      expect(writeUint32).toHaveBeenCalledWith(0x120, 0x56785678);
    });

    it('should support atomic I/O register write addresses', () => {
      const rp2350 = new RP2350();
      const testPeripheral = new BasePeripheral(rp2350, 'TestAtomic');
      vi.spyOn(testPeripheral, 'readUint32').mockReturnValue(0xff);
      const writeUint32 = vi.spyOn(testPeripheral, 'writeUint32');
      rp2350.peripherals[0x10] = testPeripheral;
      rp2350.writeUint32(0x11120, 0x0f);
      expect(writeUint32).toHaveBeenCalledWith(0x120, 0xf0);
    });
  });

  describe('rp2350js regression tests', () => {
    it('should run blink_simple', () => {
      const rp2350 = new RP2350();
      rp2350.loadBootrom(bootrom_rp2350_A2);
      const hex = fs.readFileSync('./demo/riscv_blink/blink_simple.hex', 'utf-8');
      loadHex(hex, rp2350.sram, 0x20000000);
      rp2350.core0.pc = rp2350.core1.pc = 0x20000220;
      let gpio2toggle = 0;
      let gpio25toggle = 0;
      rp2350.gpio[2].addListener((state: GPIOPinState, oldState: GPIOPinState) => {
        if (state == 1 && oldState == 0) gpio2toggle++;
      });
      rp2350.gpio[25].addListener((state: GPIOPinState, oldState: GPIOPinState) => {
        if (state == 1 && oldState == 0) gpio25toggle++;
      });
      for (let i = 0; i < 500000; i++) rp2350.step();
      expect(gpio2toggle).equals(5);
      expect(gpio25toggle).equals(2);
    });

    it('should run hello_timer', () => {
      const rp2350 = new RP2350();
      rp2350.loadBootrom(bootrom_rp2350_A2);
      const hex = fs.readFileSync('./demo/riscv_timer/hello_timer.hex', 'utf-8');
      loadHex(hex, rp2350.flash, 0x10000000);
      rp2350.core0.pc = rp2350.core1.pc = 0x10000036;
      let output = '';
      rp2350.uart[0].onByte = (value: number) => {
        process.stdout.write(new Uint8Array([value]));
        output = output + String.fromCharCode(value);
      };
      for (let i = 0; i < 250000000; i++) rp2350.step();
      expect(output.startsWith('Hello Timer!')).toBeTruthy();
      expect((output.match(/Repeat at/g) || []).length).equals(19);
    }, 20000);
  });

  it('should run pio_blink', () => {
    const rp2350 = new RP2350();
    rp2350.loadBootrom(bootrom_rp2350_A2);
    const hex = fs.readFileSync('./demo/riscv_pio_blink/pio_blink.hex', 'utf-8');
    loadHex(hex, rp2350.sram, 0x20000000);

    rp2350.core0.pc = rp2350.core1.pc = 0x20000220;
    let output = '';
    rp2350.uart[0].onByte = (value: number) => {
      process.stdout.write(new Uint8Array([value]));
      output = output + String.fromCharCode(value);
    };
    let gpio3toggle = 0;
    let gpio32toggle = 0;
    rp2350.gpio[3].addListener((state: GPIOPinState, oldState: GPIOPinState) => {
      rp2350.gpio[3].setInputValue(state == 1);
      if (state == 1 && oldState == 0) gpio3toggle++;
    });
    rp2350.gpio[32].addListener((state: GPIOPinState, oldState: GPIOPinState) => {
      rp2350.gpio[32].setInputValue(state == 1);
      if (state == 1 && oldState == 0) gpio32toggle++;
    });
    for (let i = 0; i < 2000000; i++) rp2350.step();
    expect(gpio3toggle).equals(2);
    expect(gpio32toggle).equals(2);
  }, 20000);

  describe('mtime/mtimecmp (SIO, RISC-V platform timer)', () => {
    const SIO_MTIME_CTRL = 0xd00001a4;
    const SIO_MTIME = 0xd00001b0;
    const SIO_MTIMECMP = 0xd00001b8;
    const SIO_MTIMECMPH = 0xd00001bc;

    it('MTIME_CTRL resets to 0xd (EN=1, DBGPAUSE_CORE0/1=1)', () => {
      const rp2350 = new RP2350();
      expect(rp2350.readUint32(SIO_MTIME_CTRL)).toBe(0x0000000d);
    });

    it('MTIME free-runs while enabled', () => {
      const rp2350 = new RP2350();
      const before = rp2350.readUint32(SIO_MTIME);
      rp2350.clock.tick(10_000);
      expect(rp2350.readUint32(SIO_MTIME)).toBeGreaterThan(before);
    });

    it('stops counting when MTIME_CTRL.EN is cleared', () => {
      const rp2350 = new RP2350();
      rp2350.writeUint32(SIO_MTIME_CTRL, 0);
      const before = rp2350.readUint32(SIO_MTIME);
      rp2350.clock.tick(10_000);
      expect(rp2350.readUint32(SIO_MTIME)).toBe(before);
    });

    it('MTIMECMP reads back what was written and defaults to 0xffffffff', () => {
      const rp2350 = new RP2350();
      expect(rp2350.readUint32(SIO_MTIMECMP)).toBe(0xffffffff);
      rp2350.writeUint32(SIO_MTIMECMP, 12345);
      expect(rp2350.readUint32(SIO_MTIMECMP)).toBe(12345);
      rp2350.writeUint32(SIO_MTIMECMPH, 42);
      expect(rp2350.readUint32(SIO_MTIMECMPH)).toBe(42);
    });

    it('fires SIO_IRQ_MTIMECMP on the writing core once mtime reaches mtimecmp', () => {
      const rp2350 = new RP2350();
      rp2350.currentCore = 0;
      rp2350.writeUint32(SIO_MTIMECMP, 100);
      expect(rp2350.core0.meipa[IRQ2350.SIO_IRQ_MTIMECMP]).toBeFalsy();
      rp2350.clock.tick(100_000); // 100 ticks at the 1MHz mtime rate
      expect(rp2350.core0.meipa[IRQ2350.SIO_IRQ_MTIMECMP]).toBeTruthy();
    });

    it('mtimecmp is core-local: each core gets an independent target and interrupt', () => {
      const rp2350 = new RP2350();
      rp2350.currentCore = 0;
      rp2350.writeUint32(SIO_MTIMECMP, 100);
      rp2350.currentCore = 1;
      rp2350.writeUint32(SIO_MTIMECMP, 200);

      rp2350.currentCore = 0;
      expect(rp2350.readUint32(SIO_MTIMECMP)).toBe(100);
      rp2350.currentCore = 1;
      expect(rp2350.readUint32(SIO_MTIMECMP)).toBe(200);

      // Past core0's target, before core1's.
      rp2350.clock.tick(150_000);
      expect(rp2350.core0.meipa[IRQ2350.SIO_IRQ_MTIMECMP]).toBeTruthy();
      expect(rp2350.core1.meipa[IRQ2350.SIO_IRQ_MTIMECMP]).toBeFalsy();
    });

    it('writing a new (future) mtimecmp clears the pending interrupt', () => {
      const rp2350 = new RP2350();
      rp2350.currentCore = 0;
      rp2350.writeUint32(SIO_MTIMECMP, 100);
      rp2350.clock.tick(100_000);
      expect(rp2350.core0.meipa[IRQ2350.SIO_IRQ_MTIMECMP]).toBeTruthy();

      rp2350.writeUint32(SIO_MTIMECMP, 100_000_000);
      expect(rp2350.core0.meipa[IRQ2350.SIO_IRQ_MTIMECMP]).toBeFalsy();
    });
  });
});
