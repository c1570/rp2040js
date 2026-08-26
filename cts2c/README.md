# cts2c — (Constrained) TypeScript to C transpiler for rp2350js

https://github.com/c1570/rp2350js/tree/main/cts2c

Transpiles the emulator core in `src/` to a single C file.
The C version achieves 2-4x the speed of the Node/TS version.

    cts2c.js                     the transpiler
    transpile-check.mjs          transpile all of src/, compile with gcc, summarize
    cts2c-ensure-parity.ts       Node-vs-C CRC32 parity, with divergence bisection
    cts2c-parity.spec.ts         opt-in vitest smoke test wrapping the above
    helper-cts2c-ensure-parity.c C harness the parity check drives
    helper-checks.c              standalone checks of the hand-written C helpers

`demo/emulator-run.c` is a C port of `demo/emulator-run.ts` showing how to drive the
generated emulator: UART output, GPIO listeners, stepping.

## Verifying a change

    npm run cts2c:full                              # transpiles + gcc; expect 0 errors
    gcc -O2 cts2c/helper-checks.c -o /tmp/b -lm && /tmp/b
    CTS2C_PARITY=1 npx vitest run cts2c             # 5M-cycle parity, both arches

    # more thorough check, takes minutes
    npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_blink/blink_simple.hex 400000000 riscv
    npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_pio_blink/pio_blink.hex 400000000 riscv
    npx tsx cts2c/cts2c-ensure-parity.ts demo/m33_blink/blink_simple.hex 400000000 arm
    npx tsx cts2c/cts2c-ensure-parity.ts demo/hello_serial_rp2040/hello_serial.hex 400000000 rp2040

## Scope

RP2350 (RISC-V and ARM cores) and RP2040 are both supported and covered by the CI parity
check above. RP2040 support relies on `monomorphize-chip-classes.mjs` to specialize
ChipType-generic peripheral classes per chip, since cts2c's class monomorphization otherwise
always resolves `ChipType` to RP2350.
