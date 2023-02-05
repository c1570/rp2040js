#include <stdio.h>
#include "pico/stdlib.h"
#include "pico/platform.h"
#include "hardware/structs/systick.h"

uint32_t su0, su1, sv0, sv1;

int main() {
  systick_hw->csr = 0x5;
  systick_hw->rvr = 0x00FFFFFF;

  uint32_t w = 0;
  uint32_t x = 0;

  su0=systick_hw->cvr;
  //asm volatile(".syntax unified\nldrb	r3, [r4, r2]" ::: "r3", "r4", "r2");
  w += systick_hw->cvr;
  w += systick_hw->cvr;
  w += systick_hw->cvr;
  w += systick_hw->cvr;
  w += systick_hw->cvr;
  w += systick_hw->cvr;
  w += systick_hw->cvr;
  w += systick_hw->cvr;
  su1=systick_hw->cvr;

  sv0=systick_hw->cvr;
  rp2040_chip_version(); // this accesses an APB peripheral
  rp2040_chip_version(); //  that use up two/three extra cycles
  rp2040_chip_version();
  rp2040_chip_version();
  rp2040_chip_version();
  sv1=systick_hw->cvr;

  stdio_init_all();
  for(;;) {
    printf("\n          su0-su1=%ld (expected: 30)\n", su0-su1);
    printf("\n          sv0-sv1=%ld (expected: 64)\n", sv0-sv1);
    printf("w: %lu, x: %lu\n\n", w, x);
    busy_wait_us(5000000);
  }
}
