// C variant of emulator-run.ts, using the cts2c-transpiled emulator.
// Build: gcc -O3 -o demo/emulator-run demo/emulator-run.c -lm
// (needs build/transpile/rp2350js-c.h — run `npm run cts2c:full` first)

#include "../build/transpile/rp2350js-c.h"

#include <inttypes.h>
#include <stdio.h>

#define FIRMWARE "demo/riscv_blink/blink_simple.hex"
#define LOG_GPIOS 1

// Cycles between "Time:" lines; 40M at the default 125MHz clock is 0.32s emulated.
#define TIME_UPDATE_CYCLES 40000000

static RP2350* mcu;

static void on_uart_byte(void* ctx, int32_t value) {
  (void)ctx;
  putchar((int)(value & 0xff));
}

// One listener per pin, so each can identify itself: the callback signature carries the
// state but not which pin changed.
#define GPIO_LOOPBACK_PINS 11

static void gpio_loopback(int pin, GPIOPinState state) {
  bool high = state == GPIOPinState_High;
  GPIOPin_setInputValue(mcu->gpio[pin], high);
  if (LOG_GPIOS) printf("GPIO %d: %s\n", pin, high ? "true" : "false");
}

#define GPIO_LISTENER(pin)                                          \
  static void gpio_listener_##pin(GPIOPinState state, GPIOPinState oldState) { \
    (void)oldState;                                                 \
    gpio_loopback(pin, state);                                      \
  }
GPIO_LISTENER(0)
GPIO_LISTENER(1)
GPIO_LISTENER(2)
GPIO_LISTENER(3)
GPIO_LISTENER(4)
GPIO_LISTENER(5)
GPIO_LISTENER(6)
GPIO_LISTENER(7)
GPIO_LISTENER(8)
GPIO_LISTENER(9)
GPIO_LISTENER(10)

static GPIOPinListener gpio_listeners[GPIO_LOOPBACK_PINS] = {
  gpio_listener_0, gpio_listener_1, gpio_listener_2, gpio_listener_3,
  gpio_listener_4, gpio_listener_5, gpio_listener_6, gpio_listener_7,
  gpio_listener_8, gpio_listener_9, gpio_listener_10,
};

int main(void) {
  RP2350Options options = {.coreArch = "riscv", .loadFirmware = FIRMWARE};
  mcu = RP2350_new(&options);

  mcu->uart[0]->onByte_fn = on_uart_byte;

  // Make GPIOs see their own output values as input.
  for (int i = 0; i < GPIO_LOOPBACK_PINS; i++) {
    GPIOPin_addListener(mcu->gpio[i], gpio_listeners[i]);
  }

  // The TS version also loads .dis files for printDisassembly(); that is regex-based and
  // has no C equivalent, so it is left out here.
  int64_t next_time_update = 0;
  for (;;) {
    RP2350_step(mcu);
    const int64_t cycles = RP2350_cycles_get(mcu);
    if (cycles > next_time_update) {
      printf("Time: %g secs\n", (double)(cycles / TIME_UPDATE_CYCLES) / 10.0);
      fflush(stdout);
      next_time_update += TIME_UPDATE_CYCLES;
    }
  }
}
