/**
 * Copyright (c) 2020 Raspberry Pi (Trading) Ltd.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include "pico/stdlib.h"
#include "pico/multicore.h"

#define LED_DELAY_US 1000
#define SECOND_LED_DELAY_US 400
#define SECOND_LED_PIN 2

// Initialize the GPIO for the LED
void pico_led_init(void) {
    gpio_init(PICO_DEFAULT_LED_PIN);
    gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
    gpio_init(SECOND_LED_PIN);
    gpio_set_dir(SECOND_LED_PIN, GPIO_OUT);
}

void blink_led(uint gpio, uint delay) {
    while (true) {
        gpio_put(gpio, true);
        busy_wait_us(delay);
        gpio_put(gpio, false);
        busy_wait_us(delay);
    }
}

void core1_loop() {
    blink_led(SECOND_LED_PIN, SECOND_LED_DELAY_US);
}

int main() {
    pico_led_init();
    multicore_launch_core1(core1_loop);
    blink_led(PICO_DEFAULT_LED_PIN, LED_DELAY_US);
}
