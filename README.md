## rp2350js (with rp2040 support, too)

https://github.com/c1570/rp2350js

Raspberry Pi Pico (2) emulator. Develop/test/debug RP2040/2350 projects on your PC/in your CI stack.

This is a much improved fork of Uri Shaked's [rp2040js](https://github.com/wokwi/rp2040js) project. For its original README, see [README_OLD.md](/README_OLD.md).

### Status of rp2350js

- **RISC-V/Hazard3** machine mode support (no user mode support)
- basic **ARM/Cortex M33** support (no secure/insecure mode)
- runs from bootrom
- runs both no_flash/RAM binaries and flash binaries
- runs **pico-examples/blink_simple.c, hello_timer.c, hello_usb.c**
- runs **[Connomore64](https://github.com/c1570/Connomore64)** main and video mcu (dual core, PIO, DMA)
- runs **MicroPython** (both RISC-V and ARM variants)
- **GDB interface** ("monitor" outputting PIO/GPIO info; memory watch not supported)
- **MCP server** and **Agent Skill** for interfacing with coding agents (features similar to GDB); register MCP with, e.g., `opencode mcp add` and `npx ts-node demo/mcp-server.ts`; for skill CLI helper see .opencode/.claude
- built-in cycle profiler using markers in the RP's firmware
- on recent PCs, expect about **10M cycles per second** from rp2350js
- can get **transpiled to C** for 2-8x speed increase ([cts2c](/cts2c/README.md))

#### Implemented

`*` = needs checking/fixing

```
Bootrom
GPIOs 30-47
BOOTRAM_BASE
PIO updates (register locations for INTR and up, GPIOBASE, SHIFTCTRL.IN_COUNT, CTRL.NEXTPREVx, IRQ/WAIT NEXT/PREV)
DMA updates (2->4 shared IRQs, 12->16 channels, CHxx_TRANS_COUNT/MODE, CTRL register offsets)
DREQ updates
PIO2_BASE
PIO SHIFTCTRL FJOIN_RX/FJOIN_TX
SYSINFO_BASE
SYSCFG_BASE *
TIMER1_BASE
RISC-V Platform Timer
PLL_SYS_BASE *
External interrupts *
updated IRQ constants
Xh3irq (MEIEA, MEIPA, MEIFA, MEIPRA, MEINEXT, MEICONTEXT)
Xh3power (h3.block and h3.unblock)
Xh3bextm (h3.bextmi and h3.bextm)
all Hazard3 opcodes (including RV32C, RV32Zcb, etc.; simplified reservation for lr.w/sc.w)
basic Cortex M33 support (runs Micropython)
somewhat correct instruction cycle counts *
```

#### Missing

```
Timer and System Interrupts (Xh3irq is there though)
Exceptions
Minor GPIO updates (IRQSUMMARY, USB pins, PROC1_INTxx)
Minor DMA updates (INCR_READ_REV, etc.)
DMA contention (on hardware, the whole DMA unit does one transfer per cycle, not each channel)
PIO updates (IRQx_INTE, RXF0_PUTGET0, instruction changes, etc.)
PWM updates (8->12 slices, second shared interrupt)
TIMER: registers LOCK and SOURCE
Correct timers when changing sys_clk/PLL
QMI address translation
SIO: secure vs. insecure, SIO_NONSEC_BASE
Doorbells
TMDS Encoder
RTC
XIP_MAINTENANCE_BASE
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
cycle penalties for dependent register usage, APB access, XIP access
full lr.w/sc.w reservation semantics would need (expensive) tracking of all SRAM (DMA etc.) writes
```

Notes

- Xh3irq [CSR write bypass](https://github.com/Wren6991/Hazard3/blob/787da131a1e982543d9b308c1c25a09160e71a65/hdl/hazard3_core.v#L921)
- Hazard3 [rv_opcodes.vh](https://github.com/Wren6991/Hazard3/blob/stable/hdl/rv_opcodes.vh) and [hazard3_decode.v](https://github.com/Wren6991/Hazard3/blob/787da131a1e982543d9b308c1c25a09160e71a65/hdl/hazard3_decode.v#L305)

## License

- Released under the MIT licence.
- Copyright (c) 2023-2026, github.com/c1570 (rp2350js)
- Copyright (c) 2021-2025, Uri Shaked (original rp2040js project)
- thanks go to https://github.com/0x4D44/picoem (M33 reference), https://github.com/GhostRoboticsLab/rp2350js_emulator (misc), mingpepe (initial dual core support)
