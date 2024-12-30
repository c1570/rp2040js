
export function decompress_rv32c_inst(inst: number): number {
  let index = ((inst & 0x0003) << 3) | ((inst & 0xE000) >> 13);
  let decompressor: any = decompressors[index];  //TODO
  if(!decompressor) console.log("ASSUIDHIUSHD");
  return decompressor(inst);
}

const decompressors = Array<(number) => number) = {
//  000                001          010          011           100           101        110           111
    caddi4spn_to_addi, NULL,        clw_to_lw,   NULL,         NULL,         NULL,      csw_to_sw,    NULL,         // 00
    caddi_to_addi,     cjal_to_jal, cli_to_addi, parse_011_01, parse_100_01, cj_to_jal, cbeqz_to_beq, cbenz_to_bne, // 01
    cslli_to_slli,     NULL,        clwsp_to_lw, NULL,         parse_100_10, NULL,      cswsp_to_sw,  NULL,         // 10
};




// C.ADDI4SPN, funct3 = 000, opcode = 00
function caddi4spn_to_addi(inst: number): number
{
    // decode imm and rd
    const number nzuimm = dec_ciw_imm(inst);
    const number rd = dec_rd_short(inst);

    // encode to addi rd' x2 nzuimm[9:2]
    return enc_itype(nzuimm, 2, 0b000, rd, 0b0010011);
}

// C.LW, funct3 = 010, opcode = 00
function clw_to_lw(inst: number): number
{
    // decode imm, rs1 and rd
    const number imm = dec_clw_csw_imm(inst);
    const number rs1 = dec_rs1_short(inst);
    const number rd = dec_rd_short(inst);

    // encode to lw rd', offset[6:2](rs1')
    return enc_itype(imm, rs1, 0b010, rd, 0b0000011);
}

// C.SW, funct3 = 110, opcode = 00
function csw_to_sw(inst: number): number
{
    // decode imm, rs1 and rs2
    const number imm = dec_clw_csw_imm(inst);
    const number rs1 = dec_rs1_short(inst);
    const number rs2 = dec_rs2_short(inst);

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
    const number rd = dec_rd(inst);
    number nzimm = 0;
    nzimm |= (inst & CI_MASK_12) >> 7;
    nzimm |= (inst & (CI_MASK_6_4 | CI_MASK_3_2)) >> 2;
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
    const number imm = dec_cj_imm(inst);

    // encode to jal x1, offset[11:1]
    return enc_jtype(imm, 1, 0b1101111);
}

// C.LI, funct3 = 010, opcode = 01
function cli_to_addi(inst: number): number
{
    // decode imm and rd
    const number rd = dec_rd(inst);
    number imm = 0;
    imm |= (inst & CI_MASK_12) >> 7;
    imm |= (inst & (CI_MASK_6_4 | CI_MASK_3_2)) >> 2;
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
    number nzimm = 0;
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
    const number rd = dec_rd(inst);
    number nzimm = 0;
    nzimm |= (inst & CI_MASK_12) << 5;
    nzimm |= (inst & (CI_MASK_6_4 | CI_MASK_3_2)) << 10;
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
    number shamt = 0;
    shamt |= (inst & CI_MASK_12) >> 7;
    // shamt[5] must be zero for RV32C
    assert(shamt == 0);
    shamt |= (inst & (CI_MASK_6_4 | CI_MASK_3_2)) >> 2;
    // ensure shamt != 0
    assert(shamt != 0);

    const number rd = dec_rs1_short(inst);

    // encode to srli rd', rd', shamt[5:0]
    return enc_rtype(0b0000000, shamt, rd, 0b101, rd, 0b0010011);
}

function csrai_to_srai(inst: number): number
{
    // decode shamt and rd = rs1
    number shamt = 0;
    shamt |= (inst & CI_MASK_12) >> 7;
    // shamt[5] must be zero for RV32C
    assert(shamt == 0);
    shamt |= (inst & (CI_MASK_6_4 | CI_MASK_3_2)) >> 2;
    // ensure shamt != 0
    assert(shamt != 0);

    const number rd = dec_rs1_short(inst);

    // encode to srai rd', rd', shamt[5:0]
    return enc_rtype(0b0100000, shamt, rd, 0b101, rd, 0b0010011);
}

function candi_to_andi(inst: number): number
{
    // decode imm and rd = rs1
    const number rd = dec_rs1_short(inst);
    number imm = 0;
    imm |= (inst & CI_MASK_12) >> 7;
    imm |= (inst & (CI_MASK_6_4 | CI_MASK_3_2)) >> 2;
    imm = sign_extend(imm, 5);

    // encode to andi rd', rd', imm[5:0]
    return enc_itype(imm, rd, 0b111, rd, 0b0010011);
}

function csub_to_sub(inst: number): number
{
    // decode rd = rs1 and rs2
    const number rd = dec_rs1_short(inst);
    const number rs2 = dec_rs2_short(inst);

    // encode to sub rd', rd', rs2'
    return enc_rtype(0b0100000, rs2, rd, 0b000, rd, 0b0110011);
}

function cxor_to_xor(inst: number): number
{
    // decode rd = rs1 and rs2
    const number rd = dec_rs1_short(inst);
    const number rs2 = dec_rs2_short(inst);

    // encode to xor rd', rd', rs2'
    return enc_rtype(0b0000000, rs2, rd, 0b100, rd, 0b0110011);
}

function cor_to_or(inst: number): number
{
    // decode rd = rs1 and rs2
    const number rd = dec_rs1_short(inst);
    const number rs2 = dec_rs2_short(inst);

    // encode to or rd', rd', rs2'
    return enc_rtype(0b0000000, rs2, rd, 0b110, rd, 0b0110011);
}

function cand_to_and(inst: number): number
{
    // decode rd = rs1 and rs2
    const number rd = dec_rs1_short(inst);
    const number rs2 = dec_rs2_short(inst);

    // encode to and rd', rd', rs2'
    return enc_rtype(0b0000000, rs2, rd, 0b111, rd, 0b0110011);
}

// C.J, funct3 = 101, opcode = 01
function cj_to_jal(inst: number): number
{
    // decode imm
    const number imm = dec_cj_imm(inst);

    // encode to jal x0, offset[11:1]
    return enc_jtype(imm, 0, 0b1101111);
}

// C.BEQZ, funct3 = 110, opcode = 01
function cbeqz_to_beq(inst: number): number
{
    // decode offset and rs1
    const number offset = dec_branch_imm(inst);
    const number rs1 = dec_rs1_short(inst);

    // encode to beq rs1', x0, offset[8:1]
    return enc_btype(offset, 0, rs1, 0b000, 0b1100011);
}

// C.BENZ, funct3 = 111, opcode = 01
function cbenz_to_bne(inst: number): number
{
    // decode offset and rs1
    const number offset = dec_branch_imm(inst);
    const number rs1 = dec_rs1_short(inst);

    // encode to bne rs1', x0, offset[8:1]
    return enc_btype(offset, 0, rs1, 0b001, 0b1100011);
}

// C.SLLI, funct3 = 000, opcode = 10
function cslli_to_slli(inst: number): number
{
    // decode shamt and rd
    number shamt = 0;
    shamt |= (inst & CI_MASK_12) >> 7;
    // shamt[5] must be zero for RV32C
    assert(shamt == 0);
    shamt |= (inst & (CI_MASK_6_4 | CI_MASK_3_2)) >> 2;
    // ensure shamt != 0
    assert(shamt != 0);

    const number rd = dec_rd(inst);
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
    number offset = 0;
    offset |= (inst & CI_MASK_12) >> 7;
    offset |= (inst & CI_MASK_6_4) >> 2;
    offset |= (inst & CI_MASK_3_2) << 4;

    const number rd = dec_rd(inst);
    // ensure rd != 0
    assert(rd != 0);

    // decode to lw rd, offset[7:2](x2)
    return enc_itype(offset, 2, 0b010, rd, 0b0000011);
}

function cjr_to_jalr(inst: number): number
{
    // decode rs1
    const number rs1 = dec_rs1(inst);
    // ensure rs1 != 0
    assert(rs1 != 0);

    // encode to jalr x0, rs1, 0
    return enc_itype(0, rs1, 0b000, 0, 0b1100111);
}

function cmv_to_add(inst: number): number
{
    // decode rs2 and rd
    const number rs2 = dec_rs2(inst);
    // ensure rs2 != 0
    assert(rs2 != 0);

    const number rd = dec_rd(inst);
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
    const number rs1 = dec_rs1(inst);
    // ensure rs1 != 0
    assert(rs1 != 0);

    // encode to jalr x1, rs1, 0
    return enc_itype(0, rs1, 0b000, 1, 0b1100111);
}

function cadd_to_add(inst: number): number
{
    // decode rs2 and rd
    const number rs2 = dec_rs2(inst);
    // ensure rs2 != 0
    assert(rs2 != 0);

    const number rd = dec_rd(inst);
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
    const number offset = dec_css_imm(inst);
    const number rs2 = dec_rs2(inst);

    // encode to sw rs2, offset[7:2](x2)
    return enc_stype(offset, rs2, 2, 0b010, 0b0100011);
}

// funct3 = 011, opcode = 01
function parse_011_01(inst: number): number
{
    const number rd = dec_rd(inst);

    if (rd == 2)
        return caddi16sp_to_addi(inst);
    else
        return clui_to_lui(inst);
}

// funct3 = 100, opcode = 01
function parse_100_01(inst: number): number
{
    const number cb_funct2 = dec_cb_funct2(inst);
    const number cs_funct2 = dec_cs_funct2(inst);

    switch (cb_funct2) {
    case 0b00:
        return csrli_to_srli(inst);
    case 0b01:
        return csrai_to_srai(inst);
    case 0b10:
        return candi_to_andi(inst);
    default:
        switch (cs_funct2) {
        case 0b00:
            return csub_to_sub(inst);
        case 0b01:
            return cxor_to_xor(inst);
        case 0b10:
            return cor_to_or(inst);
        case 0b11:
            return cand_to_and(inst);
        default:
            return cnop_to_addi();  // Reserved
        }
    }
}

// funct3 = 100, opcode = 10
function parse_100_10(inst: number): number
{
    const number cr_funct4 = dec_cr_funct4(inst);
    const number rs1 = dec_rs1(inst);
    const number rs2 = dec_rs2(inst);

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






enum {
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
static inline number dec_rd(uint16_t inst)
{
    return (inst & C_RD) >> 7;
}

// decode rs1 field
static inline number dec_rs1(uint16_t inst)
{
    return (inst & C_RS1) >> 7;
}

// decode rs2 field
static inline number dec_rs2(uint16_t inst)
{
    return (inst & C_RS2) >> 2;
}

// decode rd' field and return its correspond register
static inline number dec_rd_short(uint16_t inst)
{
    return ((inst & C_RD_S) >> 2) | 0b1000;
}

// decode rs1' field and return its correspond register
static inline number dec_rs1_short(uint16_t inst)
{
    return ((inst & C_RS1_S) >> 7) | 0b1000;
}

// decode rs2' field and return its correspond register
static inline number dec_rs2_short(uint16_t inst)
{
    return ((inst & C_RS2_S) >> 2) | 0b1000;
}

// sign extend from specific position to MSB
static inline number sign_extend(number x, uint8_t sign_position)
{
    number sign = (x >> sign_position) & 1;
    for (uint8_t i = sign_position + 1; i < 32; ++i)
        x |= sign << i;
    return x;
}

// decode CR-format instruction funct4 field
static inline number dec_cr_funct4(uint16_t inst)
{
    return (inst & CR_FUNCT4) >> 12;
}

// decode CSS-format instruction immediate
static inline number dec_css_imm(uint16_t inst)
{
    // zero-extended offset, scaled by 4
    number imm = 0;
    imm |= (inst & CSS_IMM_7_6) >> 1;
    imm |= (inst & CSS_IMM_5_2) >> 7;
    return imm;
}

// decode CIW-format instruction immediate
static inline number dec_ciw_imm(uint16_t inst)
{
    // zero-extended non-zero immediate, scaled by 4
    number imm = 0;
    imm |= (inst & CIW_IMM_9_6) >> 1;
    imm |= (inst & CIW_IMM_5_4) >> 7;
    imm |= (inst & CIW_IMM_3) >> 2;
    imm |= (inst & CIW_IMM_2) >> 4;
    assert(imm != 0);
    return imm;
}

// decode immediate of C.LW and C.SW
static inline number dec_clw_csw_imm(uint16_t inst)
{
    // zero-extended offset, scaled by 4
    number imm = 0;
    imm |= (inst & CLWSW_IMM_6) << 1;
    imm |= (inst & CLWSW_IMM_5_3) >> 7;
    imm |= (inst & CLWSW_IMM_2) >> 4;
    return imm;
}

// decode CS-format instruction funct6 field
static inline number dec_cs_funct6(uint16_t inst)
{
    return (inst & CS_FUNCT6) >> 10;
}

// decode CS-format instruction funct2 field
static inline number dec_cs_funct2(uint16_t inst)
{
    return (inst & CS_FUNCT2) >> 5;
}

// decode CB-format instruction funct2 field
static inline number dec_cb_funct2(uint16_t inst)
{
    return (inst & CB_FUNCT2) >> 10;
}

// decode immediate of branch instruction
static inline number dec_branch_imm(uint16_t inst)
{
    // sign-extended offset, scaled by 2
    number imm = 0;
    imm |= (inst & CB_OFFSET_8) >> 4;
    imm |= (inst & CB_OFFSET_7_6) << 1;
    imm |= (inst & CB_OFFSET_5) << 3;
    imm |= (inst & CB_OFFSET_4_3) >> 7;
    imm |= (inst & CB_OFFSET_2_1) >> 2;
    imm = sign_extend(imm, 8);
    return imm;
}

// decode CJ-format instruction immediate
static inline number dec_cj_imm(uint16_t inst)
{
    // sign-extended offset, scaled by 2
    number imm = 0;
    imm |= (inst & CJ_OFFSET_11) >> 1;
    imm |= (inst & CJ_OFFSET_10) << 2;
    imm |= (inst & CJ_OFFSET_9_8) >> 1;
    imm |= (inst & CJ_OFFSET_7) << 1;
    imm |= (inst & CJ_OFFSET_6) >> 1;
    imm |= (inst & CJ_OFFSET_5) << 3;
    imm |= (inst & CJ_OFFSET_4) >> 7;
    imm |= (inst & CJ_OFFSET_3_1) >> 2;
    imm = sign_extend(imm, 11);
    return imm;
}

// encode R-type instruction
static inline number enc_rtype(number funct7, number rs2, number rs1, number funct3, number rd, number opcode)
{
    inst: number = 0;
    inst |= funct7 << 25;
    inst |= rs2 << 20;
    inst |= rs1 << 15;
    inst |= funct3 << 12;
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}

// encode I-type instruction
static inline number enc_itype(number imm, number rs1, number funct3, number rd, number opcode)
{
    inst: number = 0;
    inst |= imm << 20;
    inst |= rs1 << 15;
    inst |= funct3 << 12;
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}

// encode S-type instruction
static inline number enc_stype(number imm, number rs2, number rs1, number funct3, number opcode)
{
    inst: number = 0;
    inst |= (imm & 0b111111100000) << 20;
    inst |= rs2 << 20;
    inst |= rs1 << 15;
    inst |= funct3 << 12;
    inst |= (imm & 0b000000011111) << 7;
    inst |= opcode;
    return inst;
}

// encode B-type instruction
static inline number enc_btype(number imm, number rs2, number rs1, number funct3, number opcode)
{
    inst: number = 0;
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
static inline number enc_utype(number imm, number rd, number opcode)
{
    inst: number = 0;
    inst |= imm;
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}

// encode J-type instruction
static inline number enc_jtype(number imm, number rd, number opcode)
{
    inst: number = 0;
    inst |= (imm & 0x00100000) << 11;
    inst |= (imm & 0x000007FE) << 20;
    inst |= (imm & 0x00000800) << 9;
    inst |= (imm & 0x000FF000);
    inst |= rd << 7;
    inst |= opcode;
    return inst;
}
