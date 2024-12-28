import { Assembler } from "../Assembler/assembler";

describe('Testing assembleLine function:', () => {
  test('Input: addi, x17, x0, 93', () => {
    expect(Assembler.assembleLine('addi, x17, x0, 93')).toHaveProperty('binary', 0x05D00893)
  })

  test('Input: add fp, a2, t4', () => {
    expect(Assembler.assembleLine('add fp, a2, t4')).toHaveProperty('binary', 0x01D60433)
  })

  test('Input: beq tp, ra, 0xC', () => {
    expect(Assembler.assembleLine('beq tp, ra, 0xC')).toHaveProperty('binary', 0x00120663)
  })

  test('Input: jal s5, 0xF7B4', () => {
    expect(Assembler.assembleLine('jal s5, 0xF7B4')).toHaveProperty('binary', 0x7B40FAEF)
  })

  test('Input auipc a3, 0xABCD000', () => {
    expect(Assembler.assembleLine('auipc a3, 0xABCD000')).toHaveProperty('binary', 0x0ABCD697)
  })

  test('Input: sh t2, 0x35C(a0)', () => {
    expect(Assembler.assembleLine('sh t2, 0x35C(a0)')).toHaveProperty('binary', 0x34751E23)
  })

  test('Input: srai x5, x2, 5', () => {
    expect(Assembler.assembleLine('srai x5, x2, 5')).toHaveProperty('binary', 0x40515293)
  })

  test('Input: jalr ra, 1089(a7)', () => {
    expect(Assembler.assembleLine('jalr ra, 1089(a7)')).toHaveProperty('binary', 0x441880E7)
  })

  test('Input: ecall', () => {
    expect(Assembler.assembleLine('ecall')).toHaveProperty('binary', 0x00000073)
  })
});