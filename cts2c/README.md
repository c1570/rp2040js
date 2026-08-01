# cts2c — (Constrained) TypeScript to C transpiler for rp2350js

https://github.com/c1570/rp2350js/tree/main/cts2c

Transpiles the emulator core in `src/` to a single C file.
The C version achieves 2-4x the speed of the Node/TS version.

    cts2c.js                     the transpiler
    transpile-check.mjs          transpile all of src/, compile with gcc, summarize
    cts2c-ensure-parity.ts       Node-vs-C CRC32 parity, with divergence bisection
    cts2c-parity.spec.ts         opt-in vitest smoke test wrapping the above
    helper-cts2c-ensure-parity.c C harness the parity check drives
    helper-bitpun-check.c        standalone check of the hand-written C bodies

## Verifying a change

    npm run cts2c:full                              # transpiles + gcc; expect 0 errors
    gcc -O2 cts2c/helper-bitpun-check.c -o /tmp/b && /tmp/b
    CTS2C_PARITY=1 npx vitest run cts2c             # 5M-cycle parity, both arches

    # more thorough check, takes minutes
    npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_blink/blink_simple.hex 400000000 riscv
    npx tsx cts2c/cts2c-ensure-parity.ts demo/riscv_pio_blink/pio_blink.hex 400000000 riscv
    npx tsx cts2c/cts2c-ensure-parity.ts demo/m33_blink/blink_simple.hex 400000000 arm

## Scope

RP2350 only. RP2040 is explicitly out of scope for now.
