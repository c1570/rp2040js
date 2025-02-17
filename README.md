## WIP! rp2040js / rp2350js (RISC-V only)
https://github.com/c1570/rp2040js

For generic/original rp2040js docs, [see below](#rp2040js).

### Status of rp2350js
* limited RISC-V/Hazard3 support (no ARM support)
* runs both no_flash/RAM binaries and flash binaries
* runs pico-examples/blink_simple.c and hello_timer.c
* runs [Connomore64](https://github.com/c1570/Connomore64) main mcu (dual core, PIO)

#### Missing

```
Timer and System Interrupts
Exceptions
GPIO updates (IRQSUMMARY, USB pins, PROC1_INTxx)
DMA updates (12->16 DMA channels, 2->4 shared IRQs, CHxx_TRANS_COUNT changes, INCR_READ_REV, etc.)
PIO updates (IRQx_INTE, RXF0_PUTGET0, instruction changes, etc.)
PWM updates (8->12 slices, second shared interrupt)
TIMER: registers LOCK and SOURCE
Correct timers when changing sys_clk/PLL
SIO: secure vs. insecure, SIO_NONSEC_BASE
Doorbells
RISC-V Platform Timer
TMDS Encoder
RTC
XIP_AUX_BASE
XOSC_BASE
PLL_USB_BASE
ACCESSCTRL_BASE
BUSCTRL_BASE
HSTX_FIFO_BASE
HSTX_CTRL_BASE
XIP_CTRL_BASE
XIP_QMI_BASE
WATCHDOG_BASE
ROSC_BASE
TRNG_BASE
SHA256_BASE
POWMAN_BASE *
TICKS_BASE
OTP_BASE ...
CORESIGHT_PERIPH_BASE ...
GLITCH_DETECTOR_BASE

Hazard3: Machine vs. User mode
Xh3pmpm (Physical Memory Protection PMP)
Xh3bextm
cycle penalties for dependent register usage and APB access
RV32Zcb (lh, mul, sb, sext.b, sext.h, sh, zext.b, zext.h)
amoadd.w
amoand.w
amomax.w
amomaxu.w
amomin.w
amominu.w
amoswap.w
amoxor.w
binv
binvi
brev8
clz
cm.mva01s
cm.mvsa01
cm.pop
cm.popret
cm.popretz
cm.push
div
ebreak
fence *
fence.i *
maxu
min
minu
mulh
mulhsu
neg
orc.b
ori
orn
rem
rol
ror
rori
sc.w
sgtz
unzip
wfi
zip
```

Notes
* Xh3irq [CSR write bypass](https://github.com/Wren6991/Hazard3/blob/787da131a1e982543d9b308c1c25a09160e71a65/hdl/hazard3_core.v#L921)
* Hazard3 [rv_opcodes.vh](https://github.com/Wren6991/Hazard3/blob/stable/hdl/rv_opcodes.vh) and [hazard3_decode.v](https://github.com/Wren6991/Hazard3/blob/787da131a1e982543d9b308c1c25a09160e71a65/hdl/hazard3_decode.v#L305):

#### Implemented
`*` = needs checking/fixing

```
Bootrom * (varmulet mostly untested)
GPIOs 30-47
BOOTRAM_BASE
PIO updates (register locations for INTR and up, GPIOBASE)
PIO2_BASE
SYSINFO_BASE
SYSCFG_BASE *
TIMER1_BASE
PLL_SYS_BASE *
External interrupts *
updated IRQ constants
Xh3irq (MEIEA, MEIPA, MEIFA, MEIPRA, MEINEXT, MEICONTEXT) *
Xh3power (h3.block and h3.unblock)
RV32C
RV32Zcb (lbu, lhu, not)
somewhat correct instruction cycle counts *
add
addi
and
andi
andn
auipc
amoor.w
beq
beqz
bclr
bclri
bext
bexti
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
bset
bseti
cpop
csrc
csrci
csrr
csrrc
csrrci
csrrs
csrrsi
csrrw
csrrwi
csrs
csrsi
csrw
csrwi
ctz
divu *
ecall *
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
max
mret *
mul *
mulhu *
mv
nop
not
or
pack
packh
remu *
ret
rev8
sb
seqz
sext.b
sext.h
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
xnor
xor
xori
zext.b
zext.h
```

## This is a project specific fork of rp2040js.
## It is used for developing the [Connomore64](https://github.com/c1570/Connomore64).
https://github.com/c1570/rp2040js

Features:
- somewhat accurate PIO timings (also, MUCH slower emulation)
- built-in cycle profiler using markers in the code
- Dual Core support (by mingpepe)
- a WIP demo wiring up several RP2040s using an 8 bit bus and gathering debug info, simulating GPIO latency
  - this is the runner used for developing the [Connomore64](https://github.com/c1570/Connomore64)
- a lot of dirty hacks and tests not suitable for pushing upstream

# Upstream documentation

## rp2040js

Raspberry Pi Pico Emulator for the [Wokwi Simulation Platform](https://wokwi.com). It blinks, runs Arduino code, and even the MicroPython REPL!

## Online examples

If you are just looking to play around with the Raspberry Pi Pico Simulator, check out the Wokwi Simulator:

- [Raspberry Pi Pico Traffic Light](https://wokwi.com/arduino/projects/297322571959894536)
- [LCD1602 Hello World](https://wokwi.com/arduino/projects/297323005822894602)
- [MicroPython Blink](https://wokwi.com/arduino/projects/300504213470839309)
- [MicroPython 7-Segment Counter](https://wokwi.com/arduino/projects/300210834979684872)

For more information, take a look at the [wokwi-pi-pico docs](https://docs.wokwi.com/parts/wokwi-pi-pico) and the [Pi Pico MicroPython Guide](https://docs.wokwi.com/guides/micropython).

If you want to develop your own application using the Raspberry Pi Pico simulator, the following examples may be helpful:

- [Blink LEDs with RP2040js, from scratch](https://stackblitz.com/edit/rp2040js-blink?file=index.ts) - Press "Run" and patiently wait for the code to compile ;-)

## Run the demo project

### Native code

You'd need to get `hello_uart.hex` by building it from the [pico-examples repo](https://github.com/raspberrypi/pico-examples/tree/master/uart/hello_uart), then copy it to the rp2040js root directory and run:

```
npm install
npm start
```

### MicroPython code

To run the MicroPython demo, first download [RPI_PICO-20230426-v1.20.0.uf2](https://micropython.org/resources/firmware/RPI_PICO-20230426-v1.20.0.uf2), place it in the rp2040js root directory, then run:

```
npm install
npm run start:micropython
```

and enjoy the MicroPython REPL! Quit the REPL with Ctrl+X. A different MicroPython UF2 image can be loaded by supplying the `--image` option:

```
npm run start:micropython -- --image=my_image.uf2
```

A GDB server on port 3333 can be enabled by specifying the `--gdb` flag:

```
npm run start:micropython -- --gdb
```

For using the MicroPython demo code in tests, the `--expect-text` can come handy: it will look for the given text in the serial output and exit with code 0 if found, or 1 if not found. You can find an example in [the MicroPython CI test](./github/workflows/ci-micropython.yml).

#### Filesystem support

With MicroPython, you can use the filesystem on the Pico. This becomes useful as more than one script file is used in your code. Just put a [LittleFS](https://github.com/littlefs-project/littlefs) formatted filesystem image called `littlefs.img` into the rp2040js root directory, and your `main.py` will be automatically started from there.

A simple way to create a suitable LittleFS image containing your script files is outlined in [create_littlefs_image.py](https://github.com/tomods/GrinderController/blob/358ad3e0f795d8cc0bdf4f21bb35f806871d433f/tools/create_littlefs_image.py).
So, using [littlefs-python](https://pypi.org/project/littlefs-python/), you can do the following:

```python
from littlefs import LittleFS
files = ['your.py', 'files.py', 'here.py', 'main.py']
output_image = 'output/littlefs.img'  # symlinked/copied to rp2040js root directory
lfs = LittleFS(block_size=4096, block_count=352, prog_size=256)
for filename in files:
    with open(filename, 'rb') as src_file, lfs.open(filename, 'w') as lfs_file:
        lfs_file.write(src_file.read())
with open(output_image, 'wb') as fh:
    fh.write(lfs.context.buffer)
```

Other ways of creating LittleFS images can be found [here](https://github.com/wokwi/littlefs-wasm) or [here](https://github.com/littlefs-project/littlefs#related-projects).

Currently, the filesystem is not writeable, as the SSI peripheral required for flash writing is not implemented yet. If you're interested in hacking, see the discussion in https://github.com/wokwi/rp2040js/issues/88 for a workaround.

### CircuitPython code

To run the CircuitPython demo, you can follow the directions above for MicroPython, except download [adafruit-circuitpython-raspberry_pi_pico-en_US-8.0.2.uf2](https://adafruit-circuit-python.s3.amazonaws.com/bin/raspberry_pi_pico/en_US/adafruit-circuitpython-raspberry_pi_pico-en_US-8.0.2.uf2) instead of the MicroPython UF2 file. Place it in the rp2040js root directory, then run:

```
npm install
npm run start:circuitpython
```

and start the CircuitPython REPL! The rest of the experience is the same as the MicroPython demo (Ctrl+X to exit, using the `--image` and
`--gdb` options, etc).

#### Filesystem support

For CircuitPython, you can create a FAT12 filesystem in Linux using the `truncate` and `mkfs.vfat` utilities:

```shell
truncate fat12.img -s 1M  # make the image file
mkfs.vfat -F12 -S512 fat12.img  # create the FAT12 filesystem
```

You can then mount the filesystem image and add files to it:

```shell
mkdir fat12  # create the mounting folder if needed
sudo mount -o loop fat12.img fat12/  # mount the filesystem to the folder
sudo cp code.py fat12/  # copy code.py to the filesystem
sudo umount fat12/  # unmount the filesystem
```

While CircuitPython does not typically use a writeable filesystem, note that this functionality is unavailable (see MicroPython filesystem
support section for more details).

## Learn more

- [Live-coding stream playlist](https://www.youtube.com/playlist?list=PLLomdjsHtJTxT-vdJHwa3z62dFXZnzYBm)
- [Hackaday project page](https://hackaday.io/project/177082-raspberry-pi-pico-emulator)

## License

Released under the MIT licence. Copyright (c) 2021-2023, Uri Shaked.
