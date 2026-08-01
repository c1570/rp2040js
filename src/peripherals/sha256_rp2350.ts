import { IRPChip } from '../rpchip';
import { BasePeripheral, Peripheral } from './peripheral';

const CSR_OFFSET = 0x00;
const WDATA_OFFSET = 0x04;
const SUM0_OFFSET = 0x08;
const SUM7_OFFSET = 0x24;

const CSR_START_BIT = 1 << 0;
const CSR_WDATA_READY_BIT = 1 << 1;
const CSR_SUM_VALID_BIT = 1 << 2;
const CSR_BSWAP_BIT = 1 << 12;

// SHA-256 initial hash values (FIPS-180-4 §5.3.3).
const SHA256_IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

// SHA-256 round constants.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function byteswap(w: number): number {
  return (
    (((w >>> 24) & 0xff) |
      ((w >>> 8) & 0xff00) |
      ((w << 8) & 0xff0000) |
      ((w << 24) & 0xff000000)) >>>
    0
  );
}

/** Compress one 64-byte block (FIPS-180-4 §6.2.2). */
function sha256Compress(state: Uint32Array, block: Uint32Array): void {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) w[i] = block[i];
  for (let i = 16; i < 64; i++) {
    const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
    const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }

  let [a, b, c, d, e, f, g, h] = state;

  for (let i = 0; i < 64; i++) {
    const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
    const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const temp2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

/**
 * RP2350 SHA-256 hardware accelerator.
 * Reference: RP2350 datasheet §12.13.
 * CSR.START resets state; 16 WDATA writes compress one block;
 * SUM0-7 hold the 256-bit digest. BSWAP (CSR bit 12, default 1)
 * byte-swaps each WDATA word before it enters the message schedule.
 */
export class RP2350SHA256<ChipType extends IRPChip = IRPChip>
  extends BasePeripheral<ChipType>
  implements Peripheral
{
  private state = new Uint32Array(SHA256_IV);
  private wordCount = 0;
  private block = new Uint32Array(16);
  private sumValid = true; // CSR reset has SUM_VLD=1
  private bswap = true; // CSR reset has BSWAP=1

  readUint32(offset: number) {
    if (offset === CSR_OFFSET) {
      let csr = CSR_WDATA_READY_BIT | (0b10 << 8); // DMA_SIZE reset default
      if (this.sumValid) csr |= CSR_SUM_VALID_BIT;
      if (this.bswap) csr |= CSR_BSWAP_BIT;
      return csr;
    }
    if (offset >= SUM0_OFFSET && offset <= SUM7_OFFSET && (offset & 3) === 0) {
      return this.state[(offset - SUM0_OFFSET) >>> 2];
    }
    return 0;
  }

  writeUint32(offset: number, value: number) {
    const v = value >>> 0;
    if (offset === CSR_OFFSET) {
      this.bswap = !!(v & CSR_BSWAP_BIT);
      if (v & CSR_START_BIT) {
        this.state = new Uint32Array(SHA256_IV);
        this.wordCount = 0;
        this.block = new Uint32Array(16);
        this.sumValid = false;
      }
    } else if (offset === WDATA_OFFSET) {
      if (this.wordCount >= 16) return;
      this.block[this.wordCount] = this.bswap ? byteswap(v) : v;
      this.wordCount++;
      if (this.wordCount === 16) {
        sha256Compress(this.state, this.block);
        this.wordCount = 0;
        this.sumValid = true;
      }
    }
  }
}
