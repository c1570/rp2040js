import type { RP2350 } from '../rp2350';
import { decodeWord } from './decode';
import { Int53, Int53Array, Uint32 } from '../utils/types';

// Local copies of rp2350.ts's memory map (fixed by the silicon, so they cannot
// drift). Imported they would be property accesses in the range tests below,
// which getDecodeEntry runs once per instruction: measured +37% under Node.
const FLASH_START_ADDRESS = 0x10000000;
const RAM_START_ADDRESS = 0x20000000;
const FLASH_SIZE = 16 * 1024 * 1024;

function decodeUncached(chip: RP2350, address: Uint32): Int53 {
  const inst = chip.readUint16(address);
  if ((inst & 3) !== 3) return decodeWord(inst);
  return decodeWord((inst | (chip.readUint16(address + 2) << 16)) >>> 0);
}

function decodeAndCache(chip: RP2350, cache: Int53Array, idx: number, address: Uint32): Int53 {
  const packed = decodeUncached(chip, address);
  cache[idx] = packed;
  return packed;
}

export function getDecodeEntry(chip: RP2350, address: Uint32): Int53 {
  if (address >= RAM_START_ADDRESS && address < RAM_START_ADDRESS + chip.sram.length) {
    const idx = (address - RAM_START_ADDRESS) >>> 1;
    const packed = chip.sramDecode[idx];
    return packed !== 0 ? packed : decodeAndCache(chip, chip.sramDecode, idx, address);
  }
  if (address >= FLASH_START_ADDRESS && address < RAM_START_ADDRESS) {
    const idx = (address & (FLASH_SIZE - 1)) >>> 1;
    const packed = chip.flashDecode[idx];
    return packed !== 0 ? packed : decodeAndCache(chip, chip.flashDecode, idx, address);
  }
  return decodeUncached(chip, address);
}
