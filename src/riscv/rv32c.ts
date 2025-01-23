
export function decompress_rv32c_inst(inst: number): number {
  let index = ((inst & 0x0003) << 3) | ((inst & 0xE000) >> 13);
  let decompressor: any = decompressors[index];  //TODO
  //console.log(`decompressing: ${index}`);
  return decompressor(inst);
}

const decompressors: Array<((input: number) => number) | null> = [
//  000                001          010          011           100           101        110           111
    caddi4spn_to_addi, null,        clw_to_lw,   null,         zcb_100_00,   null,      csw_to_sw,    null,         // 00
    caddi_to_addi,     cjal_to_jal, cli_to_addi, parse_011_01, parse_100_01, cj_to_jal, cbeqz_to_beq, cbenz_to_bne, // 01
    cslli_to_slli,     null,        clwsp_to_lw, null,         parse_100_10, null,      cswsp_to_sw,  null,         // 10
];


function assert(a: boolean) {};


// C.ADDI4SPN, funct3 = 000, opcode = 00
function caddi4spn_to_addi(inst: number): number
{
    // decode imm and rd
    const nzuimm: number = dec_ciw_imm(inst);
    const rd: number = dec_rd_short(inst);

    // encode to addi rd' x2 nzuimm[9:2]
    return enc_itype(nzuimm, 2, 0b000, rd, 0b0010011);
}

// C.LW, funct3 = 010, opcode = 00
function clw_to_lw(inst: number): number
{
    // decode imm, rs1 and rd
    const imm: number = dec_clw_csw_imm(inst);
    const rs1: number = dec_rs1_short(inst);
    const rd: number = dec_rd_short(inst);

    // encode to lw rd', offset[6:2](rs1')
    return enc_itype(imm, rs1, 0b010, rd, 0b0000011);
}

// Zcb extension, funct3 = 100, opcode = 00 part
function zcb_100_00(inst: number): number
{
    if((inst & 0b1111110001000011) === 0b1000010000000000) {
        // c.lhu
        const uimm: number = ((inst >>> 5) & 1) << 1;
        const rs1: number = dec_rs1_short(inst);
        const rd: number = dec_rd_short(inst);

        // encode to lhu rd', uimm(rs1')
        return enc_itype(uimm, rs1, 0b101, rd, 0b0000011);
    } else if((inst & 0b1111110000000011) === 0b1000000000000000) {
        // c.lbu - e.g., 80dc lbu a5,1(s1)
        const uimm: number = (((inst >>> 5) & 1) << 1) | ((inst >>> 6) & 1);
        const rs1: number = dec_rs1_short(inst);
        const rd: number = dec_rd_short(inst);

        // encode to lbu rd', uimm(rs1')
        return enc_itype(uimm, rs1, 0b100, rd, 0b0000011);
    } else throw Error(`Unsupported Zcb instruction: 0x${inst.toString(16)}`);
}

// C.SW, funct3 = 110, opcode = 00
function csw_to_sw(inst: number): number
{
    // decode imm, rs1 and rs2
    const imm: number = dec_clw_csw_imm(inst);
    const rs1: number = dec_rs1_short(inst);
    const rs2: number = dec_rs2_short(inst);

    // encode to sw rs2', offset[6:2](rs1')
    return enc_stype(imm, rs2, rs1, 0b010, 0b0100011);
}

function cnop_to_addi(): number
{
    // encode to addi x0 x0 0
    return enc_itype(0, 0, 0b000, 0, 0b0010011);
}

// C.ADDI, funct3 = 000, opcode = 01
function caddi_to_addi(inst: number): number
{
    // decode nzimm and rd
    const rd: number = dec_rd(inst);
    let nzimm: number = 0;
    nzimm |= (inst & C.CI_MASK_12) >> 7;
    nzimm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
    nzimm = sign_extend(nzimm, 5);

    // if nzimm == 0, marked as HINT, implement as nop
    if (nzimm == 0)
        return cnop_to_addi();

    // encode to addi rd, rd, nzimm[5:0]
    return enc_itype(nzimm, rd, 0b000, rd, 0b0010011);
}

// C.JAL, funct3 = 001, opcode = 01
function cjal_to_jal(inst: number): number
{
    // decode imm
    const imm: number = dec_cj_imm(inst);

    // encode to jal x1, offset[11:1]
    return enc_jtype(imm, 1, 0b1101111);
}

// C.LI, funct3 = 010, opcode = 01
function cli_to_addi(inst: number): number
{
    // decode imm and rd
    const rd: number = dec_rd(inst);
    let imm: number = 0;
    imm |= (inst & C.CI_MASK_12) >> 7;
    imm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
    imm = sign_extend(imm, 5);

    // if rd == 0, marked as HINT, implement as nop
    if (rd == 0)
        return cnop_to_addi();

    // encode to addi rd, x0, imm[5:0]
    return enc_itype(imm, 0, 0b000, rd, 0b0010011);
}

// C.ADDI16SP, funct3 = 011, opcode = 01
function caddi16sp_to_addi(inst: number): number
{
    // decode nzimm
    let nzimm: number = 0;
    nzimm |= (inst & 0x1000) >> 3;
    nzimm |= (inst & 0x0018) << 4;
    nzimm |= (inst & 0x0020) << 1;
    nzimm |= (inst & 0x0004) << 3;
    nzimm |= (inst & 0x0040) >> 2;
    nzimm = sign_extend(nzimm, 9);

    // ensure nzimm != 0
    assert(nzimm != 0);

    // encode to addi x2, x2, nzimm[9:4]
    return enc_itype(nzimm, 2, 0b000, 2, 0b0010011);
}

// C.LUI, funct3 = 011, opcode = 01
function clui_to_lui(inst: number): number
{
    // decode nzimm and rd
    const rd: number = dec_rd(inst);
    let nzimm: number = 0;
    nzimm |= (inst & C.CI_MASK_12) << 5;
    nzimm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) << 10;
    nzimm = sign_extend(nzimm, 17);

    // ensure nzimm != 0
    assert(nzimm != 0);

    // if rd == 0, marked as HINT, implement as nop
    if (rd == 0)
        return cnop_to_addi();

    // encode to lui rd, nzuimm[17:12]
    return enc_utype(nzimm, rd, 0b0110111);
}

function csrli_to_srli(inst: number): number
{
    // decode shamt and rd = rs1
    let shamt: number = 0;
    shamt |= (inst & C.CI_MASK_12) >> 7;
    // shamt[5] must be zero for RV32C
    assert(shamt == 0);
    shamt |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
    // ensure shamt != 0
    assert(shamt != 0);

    const rd: number = dec_rs1_short(inst);

    // encode to srli rd', rd', shamt[5:0]
    return enc_rtype(0b0000000, shamt, rd, 0b101, rd, 0b0010011);
}

function csrai_to_srai(inst: number): number
{
    // decode shamt and rd = rs1
    let shamt: number = 0;
    shamt |= (inst & C.CI_MASK_12) >> 7;
    // shamt[5] must be zero for RV32C
    assert(shamt == 0);
    shamt |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
    // ensure shamt != 0
    assert(shamt != 0);

    const rd: number = dec_rs1_short(inst);

    // encode to srai rd', rd', shamt[5:0]
    return enc_rtype(0b0100000, shamt, rd, 0b101, rd, 0b0010011);
}

function candi_to_andi(inst: number): number
{
    // decode imm and rd = rs1
    const rd: number = dec_rs1_short(inst);
    let imm: number = 0;
    imm |= (inst & C.CI_MASK_12) >> 7;
    imm |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
    imm = sign_extend(imm, 5);

    // encode to andi rd', rd', imm[5:0]
    return enc_itype(imm, rd, 0b111, rd, 0b0010011);
}

function csub_to_sub(inst: number): number
{
    // decode rd = rs1 and rs2
    const rd: number = dec_rs1_short(inst);
    const rs2: number = dec_rs2_short(inst);

    // encode to sub rd', rd', rs2'
    return enc_rtype(0b0100000, rs2, rd, 0b000, rd, 0b0110011);
}

function cxor_to_xor(inst: number): number
{
    // decode rd = rs1 and rs2
    const rd: number = dec_rs1_short(inst);
    const rs2: number = dec_rs2_short(inst);

    // encode to xor rd', rd', rs2'
    return enc_rtype(0b0000000, rs2, rd, 0b100, rd, 0b0110011);
}

function cor_to_or(inst: number): number
{
    // decode rd = rs1 and rs2
    const rd: number = dec_rs1_short(inst);
    const rs2: number = dec_rs2_short(inst);

    // encode to or rd', rd', rs2'
    return enc_rtype(0b0000000, rs2, rd, 0b110, rd, 0b0110011);
}

function cand_to_and(inst: number): number
{
    // decode rd = rs1 and rs2
    const rd: number = dec_rs1_short(inst);
    const rs2: number = dec_rs2_short(inst);

    // encode to and rd', rd', rs2'
    return enc_rtype(0b0000000, rs2, rd, 0b111, rd, 0b0110011);
}

// C.J, funct3 = 101, opcode = 01
function cj_to_jal(inst: number): number
{
    // decode imm
    const imm: number = dec_cj_imm(inst);

    // encode to jal x0, offset[11:1]
    return enc_jtype(imm, 0, 0b1101111);
}

// C.BEQZ, funct3 = 110, opcode = 01
function cbeqz_to_beq(inst: number): number
{
    // decode offset and rs1
    const offset: number = dec_branch_imm(inst);
    const rs1: number = dec_rs1_short(inst);

    // encode to beq rs1', x0, offset[8:1]
    return enc_btype(offset, 0, rs1, 0b000, 0b1100011);
}

// C.BENZ, funct3 = 111, opcode = 01
function cbenz_to_bne(inst: number): number
{
    // decode offset and rs1
    const offset: number = dec_branch_imm(inst);
    const rs1: number = dec_rs1_short(inst);

    // encode to bne rs1', x0, offset[8:1]
    return enc_btype(offset, 0, rs1, 0b001, 0b1100011);
}

// C.SLLI, funct3 = 000, opcode = 10
function cslli_to_slli(inst: number): number
{
    // decode shamt and rd
    let shamt: number = 0;
    shamt |= (inst & C.CI_MASK_12) >> 7;
    // shamt[5] must be zero for RV32C
    assert(shamt == 0);
    shamt |= (inst & (C.CI_MASK_6_4 | C.CI_MASK_3_2)) >> 2;
    // ensure shamt != 0
    assert(shamt != 0);

    const rd: number = dec_rd(inst);
    // if rd == 0, marked as HINT, implement as nop
    if (rd == 0)
        return cnop_to_addi();

    // encode to slli rd, rd, shamt[5:0]
    return enc_rtype(0b0000000, shamt, rd, 0b001, rd, 0b0010011);
}

// C.LWSP, funct3 = 010, opcode = 10
function clwsp_to_lw(inst: number): number
{
    // decode offset and rd
    let offset: number = 0;
    offset |= (inst & C.CI_MASK_12) >> 7;
    offset |= (inst & C.CI_MASK_6_4) >> 2;
    offset |= (inst & C.CI_MASK_3_2) << 4;

    const rd: number = dec_rd(inst);
    // ensure rd != 0
    assert(rd != 0);

    // decode to lw rd, offset[7:2](x2)
    return enc_itype(offset, 2, 0b010, rd, 0b0000011);
}

function cjr_to_jalr(inst: number): number
{
    // decode rs1
    const rs1: number = dec_rs1(inst);
    // ensure rs1 != 0
    assert(rs1 != 0);

    // encode to jalr x0, rs1, 0
    return enc_itype(0, rs1, 0b000, 0, 0b1100111);
}

function cmv_to_add(inst: number): number
{
    // decode rs2 and rd
    const rs2: number = dec_rs2(inst);
    // ensure rs2 != 0
    assert(rs2 != 0);

    const rd: number = dec_rd(inst);
    // if rd == 0, marked as HINT, implement as nop
    if (rd == 0)
        return cnop_to_addi();

    // encode to add rd, x0, rs2
    return enc_rtype(0b0000000, rs2, 0, 0b000, rd, 0b0110011);
}

function cebreak_to_ebreak(): number
{
    // return ebreak
    return enc_itype(1, 0, 0b000, 0, 0b1110011);
}

function cjalr_to_jalr(inst: number): number
{
    // decode rs1
    const rs1: number = dec_rs1(inst);
    // ensure rs1 != 0
    assert(rs1 != 0);

    // encode to jalr x1, rs1, 0
    return enc_itype(0, rs1, 0b000, 1, 0b1100111);
}

function cadd_to_add(inst: number): number
{
    // decode rs2 and rd
    const rs2: number = dec_rs2(inst);
    // ensure rs2 != 0
    assert(rs2 != 0);

    const rd: number = dec_rd(inst);
    // if rd == 0, marked as HINT, implement as nop
    if (rd == 0)
        return cnop_to_addi();

    // encode to add rd, rd, rs2
    return enc_rtype(0b0000000, rs2, rd, 0b000, rd, 0b0110011);
}

// C.SWSP, funct3 = 110, opcode = 10
function cswsp_to_sw(inst: number): number
{
    // decode imm and rs2
    const offset: number = dec_css_imm(inst);
    const rs2: number = dec_rs2(inst);

    // encode to sw rs2, offset[7:2](x2)
    return enc_stype(offset, rs2, 2, 0b010, 0b0100011);
}

// funct3 = 011, opcode = 01
function parse_011_01(inst: number): number
{
    const rd: number = dec_rd(inst);

    if (rd == 2)
        return caddi16sp_to_addi(inst);
    else
        return clui_to_lui(inst);
}

// funct3 = 100, opcode = 01
function parse_100_01(inst: number): number
{
    const cb_funct2: number = dec_cb_funct2(inst);
    const cs_funct6_3_funct2: number = (((dec_cs_funct6(inst) >>> 2) & 1) << 2) | dec_cs_funct2(inst);

    // Actual lookup order: funct3, xlen, rdRs1Val, cb_funct2, funct6[3]+funct2
    switch (cb_funct2) {
    case 0b00:
        return csrli_to_srli(inst);
    case 0b01:
        return csrai_to_srai(inst);
    case 0b10:
        return candi_to_andi(inst);
    case 0b11:
        switch (cs_funct6_3_funct2) {
        case 0b000:
            return csub_to_sub(inst);
        case 0b001:
            return cxor_to_xor(inst);
        case 0b010:
            return cor_to_or(inst);
        case 0b011:
            return cand_to_and(inst);
        case 0b111: // c.not (Zcb)
            // TODO remove decode sanity check
            if((inst & 0b1111110001111111) === 0b1001110001110101) {
              const rd: number = dec_rs1_short(inst);
              return enc_itype(-1, rd, 0b100, rd, 0b0010011); // encode as xori rd, rd, -1
            }
        }
    }
    throw Error(`Unknown compressed instruction: 0x${inst.toString(16)}`);
}

// funct3 = 100, opcode = 10
function parse_100_10(inst: number): number
{
    const cr_funct4: number = dec_cr_funct4(inst);
    const rs1: number = dec_rs1(inst);
    const rs2: number = dec_rs2(inst);

    if (cr_funct4 == 0b1000) {
        if (rs2 == 0)
            return cjr_to_jalr(inst);
        else
            return cmv_to_add(inst);
    } else if (cr_funct4 == 0b1001) {
        if (rs1 == 0 && rs2 == 0)
            return cebreak_to_ebreak();
        else if (rs2 == 0)
            return cjalr_to_jalr(inst);
        else
            return cadd_to_add(inst);
    } else
        return cnop_to_addi();
}






enum C {
    //                ....xxxx....xxxx
    C_RD          = 0b0000111110000000, // general
    C_RS1         = 0b0000111110000000,
    C_RS2         = 0b0000000001111100,
    C_RD_S        = 0b0000000000011100,
    C_RS1_S       = 0b0000001110000000,
    C_RS2_S       = 0b0000000000011100,
    //                ....xxxx....xxxx
    CR_FUNCT4     = 0b1111000000000000, // CR-format
    //                ....xxxx....xxxx
    CI_MASK_12    = 0b0001000000000000, // CI-format
    CI_MASK_6_4   = 0b0000000001110000,
    CI_MASK_3_2   = 0b0000000000001100,
    //                ....xxxx....xxxx
    CSS_IMM_5_2   = 0b0001111000000000, // CSS-format
    CSS_IMM_7_6   = 0b0000000110000000,
    //                ....xxxx....xxxx
    CIW_IMM_5_4   = 0b0001100000000000, // CIW-format
    CIW_IMM_9_6   = 0b0000011110000000,
    CIW_IMM_2     = 0b0000000001000000,
    CIW_IMM_3     = 0b0000000000100000,
    //                ....xxxx....xxxx
    CLWSW_IMM_5_3 = 0b0001110000000000, // C.LW, C.SW
    CLWSW_IMM_2   = 0b0000000001000000,
    CLWSW_IMM_6   = 0b0000000000100000,
    //                ....xxxx....xxxx
    CS_FUNCT6     = 0b1111110000000000, // CS-format
    CS_FUNCT2     = 0b0000000001100000,
    //                ....xxxx....xxxx
    CB_FUNCT2     = 0b0000110000000000, // C.SRLI, C.SRAI, C.ANDI
    CB_OFFSET_8   = 0b0001000000000000, // C.BEQZ, C.BNEZ
    CB_OFFSET_4_3 = 0b0000110000000000,
    CB_OFFSET_7_6 = 0b0000000001100000,
    CB_OFFSET_2_1 = 0b0000000000011000,
    CB_OFFSET_5   = 0b0000000000000100,
    //                ....xxxx....xxxx
    CJ_OFFSET_11  = 0b0001000000000000, // CJ-format
    CJ_OFFSET_4   = 0b0000100000000000,
    CJ_OFFSET_9_8 = 0b0000011000000000,
    CJ_OFFSET_10  = 0b0000000100000000,
    CJ_OFFSET_6   = 0b0000000010000000,
    CJ_OFFSET_7   = 0b0000000001000000,
    CJ_OFFSET_3_1 = 0b0000000000111000,
    CJ_OFFSET_5   = 0b0000000000000100,
};
// clang-format off

// decode rd field
function dec_rd(inst: number): number
{
    return (inst & C.C_RD) >> 7;
}

// decode rs1 field
function dec_rs1(inst: number): number
{
    return (inst & C.C_RS1) >> 7;
}

// decode rs2 field
function dec_rs2(inst: number): number
{
    return (inst & C.C_RS2) >> 2;
}

// decode rd' field and return its correspond register
function dec_rd_short(inst: number): number
{
    return ((inst & C.C_RD_S) >> 2) | 0b1000;
}

// decode rs1' field and return its correspond register
function dec_rs1_short(inst: number): number
{
    return ((inst & C.C_RS1_S) >> 7) | 0b1000;
}

// decode rs2' field and return its correspond register
function dec_rs2_short(inst: number): number
{
    return ((inst & C.C_RS2_S) >> 2) | 0b1000;
}

// sign extend from specific position to MSB
function sign_extend(x: number, sign_position: number): number
{
    let sign: number = (x >> sign_position) & 1;
    for (let i: number = sign_position + 1; i < 32; ++i)
        x |= sign << i;
    return x;
}

// decode CR-format instruction funct4 field
function dec_cr_funct4(inst: number): number
{
    return (inst & C.CR_FUNCT4) >> 12;
}

// decode CSS-format instruction immediate
function dec_css_imm(inst: number): number
{
    // zero-extended offset, scaled by 4
    let imm: number = 0;
    imm |= (inst & C.CSS_IMM_7_6) >> 1;
    imm |= (inst & C.CSS_IMM_5_2) >> 7;
    return imm;
}

// decode CIW-format instruction immediate
function dec_ciw_imm(inst: number): number
{
    // zero-extended non-zero immediate, scaled by 4
    let imm: number = 0;
    imm |= (inst & C.CIW_IMM_9_6) >> 1;
    imm |= (inst & C.CIW_IMM_5_4) >> 7;
    imm |= (inst & C.CIW_IMM_3) >> 2;
    imm |= (inst & C.CIW_IMM_2) >> 4;
    assert(imm != 0);
    return imm;
}

// decode immediate of C.LW and C.SW
function dec_clw_csw_imm(inst: number): number
{
    // zero-extended offset, scaled by 4
    let imm: number = 0;
    imm |= (inst & C.CLWSW_IMM_6) << 1;
    imm |= (inst & C.CLWSW_IMM_5_3) >> 7;
    imm |= (inst & C.CLWSW_IMM_2) >> 4;
    return imm;
}

// decode CS-format instruction funct6 field
function dec_cs_funct6(inst: number): number
{
    return (inst & C.CS_FUNCT6) >> 10;
}

// decode CS-format instruction funct2 field
function dec_cs_funct2(inst: number): number
{
    return (inst & C.CS_FUNCT2) >> 5;
}

// decode CB-format instruction funct2 field
function dec_cb_funct2(inst: number): number
{
    return (inst & C.CB_FUNCT2) >> 10;
}

// decode immediate of branch instruction
function dec_branch_imm(inst: number): number
{
    // sign-extended offset, scaled by 2
    let imm: number = 0;
    imm |= (inst & C.CB_OFFSET_8) >> 4;
    imm |= (inst & C.CB_OFFSET_7_6) << 1;
    imm |= (inst & C.CB_OFFSET_5) << 3;
    imm |= (inst & C.CB_OFFSET_4_3) >> 7;
    imm |= (inst & C.CB_OFFSET_2_1) >> 2;
    imm = sign_extend(imm, 8);
    return imm;
}

// decode CJ-format instruction immediate
function dec_cj_imm(inst: number): number
{
    // sign-extended offset, scaled by 2
    let imm: number = 0;
    imm |= (inst & C.CJ_OFFSET_11) >> 1;
    imm |= (inst & C.CJ_OFFSET_10) << 2;
    imm |= (inst & C.CJ_OFFSET_9_8) >> 1;
    imm |= (inst & C.CJ_OFFSET_7) << 1;
    imm |= (inst & C.CJ_OFFSET_6) >> 1;
    imm |= (inst & C.CJ_OFFSET_5) << 3;
    imm |= (inst & C.CJ_OFFSET_4) >> 7;
    imm |= (inst & C.CJ_OFFSET_3_1) >> 2;
    imm = sign_extend(imm, 11);
    return imm;
}

// encode R-type instruction
function enc_rtype(funct7: number, rs2: number, rs1: number, funct3: number, rd: number, opcode: number): number
{
    let inst: number = 0;
    inst |= funct7 << 25;
    inst |= rs2 << 20;
    inst |= rs1 << 15;
    inst |= funct3 << 12;
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}

// encode I-type instruction
function enc_itype(imm: number, rs1: number, funct3: number, rd: number, opcode: number): number
{
    let inst: number = 0;
    inst |= imm << 20;
    inst |= rs1 << 15;
    inst |= funct3 << 12;
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}

// encode S-type instruction
function enc_stype(imm: number, rs2: number, rs1: number, funct3: number, opcode: number): number
{
    let inst: number = 0;
    inst |= (imm & 0b111111100000) << 20;
    inst |= rs2 << 20;
    inst |= rs1 << 15;
    inst |= funct3 << 12;
    inst |= (imm & 0b000000011111) << 7;
    inst |= opcode;
    return inst;
}

// encode B-type instruction
function enc_btype(imm: number, rs2: number, rs1: number, funct3: number, opcode: number): number
{
    let inst: number = 0;
    inst |= (imm & 0b1000000000000) << 19;
    inst |= (imm & 0b0011111100000) << 20;
    inst |= rs2 << 20;
    inst |= rs1 << 15;
    inst |= funct3 << 12;
    inst |= (imm & 0b0000000011110) << 7;
    inst |= (imm & 0b0100000000000) >> 4;
    inst |= opcode;
    return inst;
}

// encode U-type instruction
function enc_utype(imm: number, rd: number, opcode: number): number
{
    let inst: number = 0;
    inst |= imm;
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}

// encode J-type instruction
function enc_jtype(imm: number, rd: number, opcode: number): number
{
    let inst: number = 0;
    inst |= (imm & 0x00100000) << 11;
    inst |= (imm & 0x000007FE) << 20;
    inst |= (imm & 0x00000800) << 9;
    inst |= (imm & 0x000FF000);
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}
