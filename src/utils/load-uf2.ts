import { readFileSync } from 'fs';
import { decodeBlock } from 'uf2';
import { IRPChip } from '../rpchip';

const FLASH_START_ADDRESS = 0x10000000;
const RAM_START_ADDRESS = 0x20000000;

// See the identical DecodedUF2Block comment in load-firmware.ts — decodeBlock()'s real
// return type (uf2's UF2BlockData) lives in node_modules, which cts2c never scans.
interface DecodedUF2Block {
  flashAddress: number;
  payload: Uint8Array;
}

/**
 * Load a UF2 firmware file into memory. Each 512-byte UF2 block contains a
 * payload and a target address. Blocks targeting 0x10000000+ go into flash;
 * blocks targeting 0x20000000+ go into SRAM.
 */
export function loadUF2(filename: string, chip: IRPChip) {
  const data = readFileSync(filename);
  const buffer = new Uint8Array(512);
  for (let offset = 0; offset + 512 <= data.length; offset += 512) {
    buffer.set(data.subarray(offset, offset + 512));
    const block: DecodedUF2Block = decodeBlock(buffer);
    const { flashAddress, payload } = block;
    if (flashAddress >= RAM_START_ADDRESS) {
      chip.sram.set(payload, flashAddress - RAM_START_ADDRESS);
    } else {
      chip.flash.set(payload, flashAddress - FLASH_START_ADDRESS);
    }
  }
}
