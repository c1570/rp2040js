// Returns bits from 32-bit input in specified range
export function getRange(input: number, upperEnd: number, lowerEnd: number): number {
  if (
    upperEnd > 31 ||
    lowerEnd < 0 ||
    lowerEnd > upperEnd ||
    lowerEnd === upperEnd
  ) {
    throw new Error('Specified range not possible');
  }

  let result = input;

  if (upperEnd < 31) {
    const bitmask: number = 0xFFFFFFFF >>> (31 - upperEnd);
    result &= bitmask;
  }

  return result >>> lowerEnd;

}

// Sets bits from 32-bit input in specified range to provided value
export function setRange(input: number, value: number, upperEnd: number, lowerEnd: number): number {
  if (
    upperEnd > 31 ||
    lowerEnd < 0 ||
    lowerEnd > upperEnd ||
    lowerEnd === upperEnd
  ) {
    throw new Error('Specified range not possible');
  }

  if (value > (2 ** (1 + upperEnd - lowerEnd)) - 1) {
    throw new Error(`Value does not fit within specified range; max value: ${(2 ** (1 + upperEnd - lowerEnd)) - 1}, value supplied: ${value}`);
  }

  const lowerMask = 0xFFFFFFFF >>> (31 - lowerEnd);
  const upperMask = 0xFFFFFFFF << upperEnd;
  const bitMask = lowerMask | upperMask;

  return (input & bitMask) | (value << lowerEnd);

}

// Returns specified bit from 32-bit input
export function getBit(input: number, index: number): number {
  if (
    index > 31 ||
    index < 0
  ) {
    throw new Error('Specified index not possible');
  }

  return (input >>> index) & 0x00000001
}

// Sets the specified bit to provided value in given input
export function setBit(input: number, value: number, index: number): number {
  if (
    index > 31 ||
    index < 0
  ) {
    throw new Error('Specified index not possible');
  }

  if (value !== 0 && value !== 1) {
    throw new Error(`Specified value must be 1 or 0; value received: ${value}`);
  }

  return value === 1 ? 
    input | (1 << index) :
    (input | (1 << index)) ^ (1 << index);

}

// Sign extends input of specified width to 32 bits
export function signExtend(input: number, width: number): number {
  if (getBit(input, width - 1)) {
    const bitmask = 0xFFFFFFFF >> (32 - width);
    return setRange(input, bitmask, 31, width - 1);

  } else {
    return input;
  }
}