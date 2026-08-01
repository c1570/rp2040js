/**
 * Firmware loading helpers.
 *
 * For SRAM images, watchdog scratch[4..7] is set up as a "vectored reboot"
 * handshake that causes the bootrom to scan the SRAM window for an IMAGE_DEF
 * block and launch the firmware — replicating what nsboot does on real
 * hardware after a UF2 upload. For flash images, the bootrom does its normal
 * flash scan.
 *
 * The bootrom does NOT auto-scan SRAM on a plain reset; RAM boot requires
 * the vectored-reboot handshake (see
 * `vendor_docs/pico-bootrom-rp2350/src/main/arm/varm_boot_path.c`). The
 * layout of scratch[2..7] matches `s_varm_api_reboot` in `varm_apis.c`:
 *   scratch[2] = p0          (image_region_base for RAM_IMAGE)
 *   scratch[3] = p1          (image_region_size for RAM_IMAGE)
 *   scratch[4] = VECTORED_BOOT_MAGIC  (0xb007c0d3)
 *   scratch[5] = REBOOT_TO_MAGIC_PC ^ -magic   (-magic = 0x4ff83f2d)
 *   scratch[6] = boot_type   (e.g. BOOT_TYPE_RAM_IMAGE = 0x3)
 *   scratch[7] = REBOOT_TO_MAGIC_PC            (= VECTORED_BOOT_MAGIC)
 */

import { readFileSync } from 'fs';
import { decodeBlock } from 'uf2';
import { IRPChip } from '../rpchip';
import { loadHex } from './load-hex';

const FLASH_START_ADDRESS = 0x10000000;
const RAM_START_ADDRESS = 0x20000000;

// Vectored-boot constants (see header comment for the layout rationale).
const VECTORED_BOOT_MAGIC = 0xb007c0d3;
const REBOOT_TO_MAGIC_PC = VECTORED_BOOT_MAGIC;
const NEG_MAGIC = -VECTORED_BOOT_MAGIC >>> 0; // 0x4ff83f2d
const BOOT_TYPE_RAM_IMAGE = 0x3;

// RP2350 WATCHDOG_BASE = 0x400d8000, SCRATCH0 = 0x0c; scratch[i] = base + 0x0c + i*4
const WATCHDOG_SCRATCH0 = 0x400d800c;

export interface LoadFirmwareOptions {
  /**
   * Search window size (bytes) used for vectored RAM boot of SRAM images.
   * Defaults to 256 KB, which covers typical pico-sdk SRAM images. Set
   * larger if your image is bigger.
   */
  ramWindowSize?: number;
  /**
   * When true (default), the chip is re-initialised after the load so the
   * cores restart at the bootrom reset vector. For SRAM images on RP2350
   * the watchdog-scratch vectored-boot handshake is set up first so the
   * bootrom scans the SRAM window, finds the IMAGE_DEF, and extracts the
   * real entry PC + SP itself.
   *
   * When false, the caller takes responsibility for setting up the boot
   * (e.g. writing to `chip.core[i].PC` directly, or calling `chip.reset()`
   * themselves). The payload bytes are written into flash/SRAM but the
   * cores and watchdog scratch are left untouched. Useful for tests that
   * need to inspect pre-boot state, or for callers that want to override
   * the entry via {@link entryPc}.
   */
  initChip?: boolean;
  /**
   * Optional explicit entry PC. When set AND {@link initChip} is true, the
   * bootrom-based handoff is bypassed: cores are restarted at `entryPc`
   * directly (no watchdog scratch setup, no `reset()` re-run). Useful for
   * synthetic test fixtures that have no picobin IMAGE_DEF block, or for
   * forcing a specific entry into an image.
   */
  entryPc?: number;
}

export interface LoadFirmwareResult {
  /** Detected source format. */
  format: 'hex' | 'uf2';
  /** True if the image was placed in SRAM, false if in flash. */
  useSram: boolean;
  /**
   * Lowest absolute address that received a byte from the image. Used as the
   * SRAM window base for vectored RAM boot.
   */
  loadBase: number;
}

/**
 * Set up watchdog scratch[2..7] for a vectored RAM boot. After this is called
 * (and the chip is reset to its bootrom reset vector), the bootrom will scan
 * `[windowBase, windowBase + windowSize)` for an IMAGE_DEF block and launch
 * the firmware it finds there.
 *
 * No-op if the chip is not an RP2350 (RP2040 has no vectored boot).
 */
export function setupVectoredRamBoot<ChipType extends IRPChip = IRPChip>(
  chip: ChipType,
  windowBase: number,
  windowSize: number
): void {
  if (chip.identifier !== 'rp2350') return;
  const w = (i: number) => WATCHDOG_SCRATCH0 + i * 4;
  chip.writeUint32(w(2), windowBase >>> 0);
  chip.writeUint32(w(3), windowSize >>> 0);
  chip.writeUint32(w(4), VECTORED_BOOT_MAGIC);
  chip.writeUint32(w(5), (REBOOT_TO_MAGIC_PC ^ NEG_MAGIC) >>> 0);
  chip.writeUint32(w(6), BOOT_TYPE_RAM_IMAGE);
  chip.writeUint32(w(7), REBOOT_TO_MAGIC_PC);
}

// Re-declare decodeBlock()'s return type (lives in node_modules, unscanned by cts2c)
// to enable proper type resolution in the transpiled C build.
interface DecodedUF2Block {
  flashAddress: number;
  payload: Uint8Array;
}

/** Result of scanning a HEX image's address records (see inspectHex). */
interface HexInspection {
  useSram: boolean;
  loadBase: number;
}

/**
 * Determine whether a HEX image targets SRAM or flash by scanning the
 * extended-linear-address records. Also returns the lowest absolute data
 * address seen.
 */
function inspectHex(hex: string): HexInspection {
  let highAddressBytes = 0;
  let useSram = false;
  let loadBase = Infinity;
  for (const line of hex.split('\n')) {
    if (line[0] !== ':') continue;
    const recordType = line.substring(7, 9);
    if (recordType === '04') {
      highAddressBytes = parseInt(line.substring(9, 13), 16);
      if ((highAddressBytes << 16) >>> 0 >= RAM_START_ADDRESS) useSram = true;
    } else if (recordType === '00') {
      const byteCount = parseInt(line.substring(1, 3), 16);
      if (byteCount > 0) {
        const addr = ((highAddressBytes << 16) | parseInt(line.substring(3, 7), 16)) >>> 0;
        if (addr < loadBase) loadBase = addr;
      }
    } else if (recordType === '01') {
      break;
    }
  }
  if (loadBase === Infinity) loadBase = FLASH_START_ADDRESS;
  return { useSram, loadBase };
}

function tryLoadDisassembly<ChipType extends IRPChip = IRPChip>(
  path: string,
  chip: ChipType,
  ext: 'hex' | 'uf2'
) {
  const disPath = path.substring(0, path.length - ext.length - 1) + '.dis';
  try {
    chip.loadDisassembly(readFileSync(disPath, 'utf-8'));
  } catch {
    /* no dis file is fine */
  }
}

/**
 * Load raw Intel HEX contents into the chip's flash or SRAM (auto-detected
 * from the address records). Returns the load base and which region was used.
 */
export function loadFirmwareFromHex<ChipType extends IRPChip = IRPChip>(
  chip: ChipType,
  hex: string,
  path?: string
): LoadFirmwareResult {
  const { useSram, loadBase } = inspectHex(hex);
  if (useSram) {
    loadHex(hex, chip.sram, RAM_START_ADDRESS);
  } else {
    loadHex(hex, chip.flash, FLASH_START_ADDRESS);
  }
  if (path) tryLoadDisassembly(path, chip, 'hex');
  return { format: 'hex', useSram, loadBase };
}

/**
 * Load a UF2 file into the chip's flash or SRAM (auto-detected from the first
 * block's target address).
 */
export function loadFirmwareFromUF2<ChipType extends IRPChip = IRPChip>(
  chip: ChipType,
  path: string
): LoadFirmwareResult {
  const data = readFileSync(path);
  const buffer = new Uint8Array(512);
  let useSram = false;
  let loadBase = Infinity;

  for (let offset = 0; offset + 512 <= data.length; offset += 512) {
    buffer.set(data.subarray(offset, offset + 512));
    const block: DecodedUF2Block = decodeBlock(buffer);
    const { flashAddress, payload } = block;
    if (flashAddress >= RAM_START_ADDRESS) {
      chip.sram.set(payload, flashAddress - RAM_START_ADDRESS);
      useSram = true;
    } else {
      chip.flash.set(payload, flashAddress - FLASH_START_ADDRESS);
    }
    if (flashAddress < loadBase) loadBase = flashAddress;
  }
  if (loadBase === Infinity) loadBase = FLASH_START_ADDRESS;
  tryLoadDisassembly(path, chip, 'uf2');
  return { format: 'uf2', useSram, loadBase };
}

/**
 * Load firmware from a file path. Auto-detects HEX vs UF2 by extension,
 * auto-detects SRAM vs flash from the image's address records, and (unless
 * `options.initChip` is false) initialises the chip so the cores start
 * ready to boot the loaded image.
 *
 * Boot behaviour depends on the options:
 *   - **Default** (`initChip=true`, no `entryPc`): for SRAM images on RP2350,
 *     watchdog scratch[4..7] is set up as a vectored-boot handshake, then
 *     the chip is reset. The bootrom scans the SRAM window on the next
 *     `step()`, finds the IMAGE_DEF, and jumps to the firmware's real entry.
 *     For flash images, the bootrom does its normal flash scan after reset.
 *   - **`entryPc` set**: bypass the bootrom handoff; reset the chip and then
 *     set both cores' PC to `entryPc` directly. Use this for synthetic
 *     fixtures without an IMAGE_DEF, or to force a specific entry.
 *   - **`initChip=false`**: just write the payload bytes (flash or SRAM)
 *     and leave cores / watchdog untouched. Caller is responsible for
 *     bootstrapping.
 *
 * Adjacent `.dis` files (same basename) are loaded automatically when
 * present.
 */
export function loadFirmware<ChipType extends IRPChip = IRPChip>(
  chip: ChipType,
  path: string,
  options?: LoadFirmwareOptions
): LoadFirmwareResult {
  let result: LoadFirmwareResult;
  if (path.length >= 4 && path.substring(path.length - 4) === '.uf2') {
    result = loadFirmwareFromUF2(chip, path);
  } else {
    result = loadFirmwareFromHex(chip, readFileSync(path, 'utf-8'), path);
  }

  const initChip = options ? options.initChip ?? true : true;
  const entryPc = options ? options.entryPc : undefined;

  if (!initChip) {
    return result;
  }

  if (entryPc != null) {
    // Caller override: skip the bootrom handoff and set PC directly.
    chip.reset();
    const pc = entryPc >>> 0;
    chip.core[0].PC = pc;
    chip.core[1].PC = pc;
    return result;
  }

  if (result.useSram && chip.identifier === 'rp2350') {
    // Scratch survives reset, so set up the vectored-boot handshake first.
    setupVectoredRamBoot(
      chip,
      result.loadBase,
      options ? options.ramWindowSize ?? 0x40000 : 0x40000
    );
  }

  // Reset so cores restart at the bootrom vector, which then performs the
  // vectored-boot handoff (SRAM) or flash scan.
  chip.reset();
  return result;
}
