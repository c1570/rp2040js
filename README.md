## WIP! rp2350 support (RISC-V only) for rp2040js
https://github.com/c1570/rp2040js

### Status
runs blink_simple.c (RISC-V, busy_wait_us instead of sleep_ms, no_flash/RAM binary)

#### Missing

```
Interrupts and Exceptions
Bootrom (starting from SRAM works, varmulet doesn't)
DMA updates
PIO updates
Register offset updates
Correct timers when overclocking
SIO: secure vs. insecure, SIO_NONSEC_BASE
Doorbells
RISC-V Platform Timer
TMDS Encoder
RTC
PIO2_BASE
XIP_AUX_BASE
SYSCFG_BASE
XOSC_BASE
PLL_SYS_BASE
PLL_USB_BASE
ACCESSCTRL_BASE
BUSCTRL_BASE
TIMER1_BASE
HSTX_FIFO_BASE
HSTX_CTRL_BASE
XIP_CTRL_BASE
XIP_QMI_BASE
WATCHDOG_BASE
ROSC_BASE
TRNG_BASE
SHA256_BASE
POWMAN_BASE
TICKS_BASE
OTP_BASE ...
CORESIGHT_PERIPH_BASE ...
GLITCH_DETECTOR_BASE

Machine/User mode
Xh3irq
Xh3pmpm (Physical Memory Protection PMP)
Xh3power (slt x0, x0, x0 and slt x0, x0, x1)
Xh3bextm
correct instruction cycle counts
RV32Zcb (lh, mul, sb, sext.b, sext.h, sh, zext.b, zext.h)
amoadd.w
amoand.w
amomax.w
amomaxu.w
amomin.w
amominu.w
amoswap.w
amoxor.w
bclr
bclri
bexti
binv
binvi
brev8
bset
bseti
clz
cm.mva01s
cm.mvsa01
cm.pop
cm.popret
cm.popretz
cm.push
csrc *
csrci *
csrr *
csrrc *
csrrci *
csrrs *
csrrsi *
csrrw *
csrrwi *
csrs *
csrsi *
csrw *
csrwi *
div
ebreak
ecall
fence *
fence.i *
max
maxu
min
minu
mret
mulh
mulhsu
neg
orc.b
ori
orn
rem
remu
rev8
rol
ror
rori
sc.w
sext.b
sext.h
sgtz
unzip
wfi
xnor
zip
```

#### Implemented
`*` = needs checking/fixing

```
BOOTRAM_BASE
RV32C
RV32Zcb (lbu, lhu, not)
add
addi
and
andi
andn
auipc
amoor.w
beq
beqz
bext
bge
bgeu
bgez
bgt
bgtu
bgtz
ble
bleu
blez
blt
bltu
bltz
bne
bnez
cpop
ctz
divu *
j
jal
jalr
jr
lb
lbu
lh
lhu
lr.w
lui
lw
mul *
mulhu *
mv
nop
not
or
pack
packh
ret
sb
seqz
sh1add
sh2add
sh3add
sh
sll
slli
slt
slti
sltiu
sltu
sltz
snez
sra
srai
srl
srli
sub
sw
xor
xori
zext.b
zext.h
```
