import { getBit, getRange, setBit, setRange, signExtend } from "../binaryFunctions";

const getBitTestCases: Map<number[], number> = new Map([
  [[32, 4], 0],
  [[32, 5], 1],
  [[32, 6], 0],
  [[24, 2], 0],
  [[24, 3], 1],
  [[24, 4], 1],
  [[24, 5], 0],
  [[48, 3], 0],
  [[48, 4], 1],
  [[48, 5], 1],
  [[0x80000000, 30], 0],
  [[0x80000000, 31], 1]
]);

const setBitTestCases: Map<number[], number> = new Map([
  [[0, 1, 0], 1],
  [[0, 1, 1], 2],
  [[0, 1, 2], 4],
  [[0, 1, 3], 8],
  [[0, 1, 4], 16],
  [[0, 1, 5], 32],
  [[31, 0, 0], 30],
])

const getRangeTestCases: Map<number[], number> = new Map([
  [[0xFF, 3, 0], 0xF],
  [[0xFFFFFFFF, 31, 0], 0xFFFFFFFF],
  [[0xFFFFFFFF, 30, 0], 0x7FFFFFFF],
  [[0xFFFFFFFF, 12, 9], 0xF],
  [[0x0A0B0C0D, 23, 8], 0x0B0C]
]);

const setRangeTestCases: Map<number[], number> = new Map([
  [[0, 0xFF, 7, 0], 0xFF],
  [[0, 0xFF, 15, 8], 0xFF00],
  [[0x0A0B0C0D, 0xFF, 15, 8], 0x0A0BFF0D]
]);

describe('Testing getBit function:', () => {
  getBitTestCases.forEach((expected: number, input: number[]) => {
    test(`Input: ${input[0]}, ${input[1]}`, () => {
      expect(getBit(input[0], input[1])).toBe(expected);
    })
  })
});

describe('Testing setBit function:', () => {
  setBitTestCases.forEach((expected: number, input: number[]) => {
    test(`Input: ${input[0]}, ${input[1]}, ${input[2]}`, () => {
      expect(setBit(input[0], input[1], input[2])).toBe(expected);
    })
  })
});

describe('Testing getRange function:', () => {
  getRangeTestCases.forEach((expected: number, input: number[]) => {
    test(`Input: ${input[0]}, ${input[1]}, ${input[2]}`, () => {
      expect(getRange(input[0], input[1], input[2])).toBe(expected);
    })
  })
});

describe('Testing setRange function:', () => {
  setRangeTestCases.forEach((expected: number, input: number[]) => {
    test(`Input: ${input[0]}, ${input[1]}, ${input[2]}, ${input[3]}`, () => {
      expect(setRange(input[0], input[1], input[2], input[3])).toBe(expected);
    })
  })
});

describe('Testing signExtend:', () => {
  
  test('0xFFF as 12-bit signed int', () => {
    expect(signExtend(0xFFF, 12)).toBe(-1);
  })

  test('0xFFF as 13-bit signed int', () => {
    expect(signExtend(0xFFF, 13)).toBe(0xFFF);
  })

})