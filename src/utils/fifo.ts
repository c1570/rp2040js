export class FIFO {
  readonly buffer: Uint32Array;

  private start = 0;
  private used = 0;

  // Track capacity separately since typed array `.length` is erased when
  // transpiled to C.
  private readonly capacity: number;

  constructor(size: number) {
    this.buffer = new Uint32Array(size);
    this.capacity = size;
  }

  get size() {
    return this.capacity;
  }

  get itemCount() {
    return this.used;
  }

  push(value: number) {
    const { capacity } = this;
    const { start, used } = this;
    if (this.used < capacity) {
      this.buffer[(start + used) % capacity] = value;
      this.used++;
    }
  }

  pull() {
    const { start, used, capacity } = this;
    if (used) {
      this.start = (start + 1) % capacity;
      this.used--;
      return this.buffer[start];
    }
    return 0;
  }

  peek() {
    return this.used ? this.buffer[this.start] : 0;
  }

  reset() {
    this.used = 0;
  }

  get empty() {
    return this.used == 0;
  }

  get full() {
    return this.used === this.capacity;
  }

  get items() {
    const { start, used, buffer, capacity } = this;
    const result = [];
    for (let i = 0; i < used; i++) {
      result[i] = buffer[(start + i) % capacity];
    }
    return result;
  }
}
