cmake_minimum_required(VERSION 3.12)
include(pico_sdk_import.cmake)

project(cpu_benchmark C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

add_executable(cpu_benchmark
        cpu_benchmark.c
)

target_compile_options(cpu_benchmark PRIVATE -Wall -O2)

target_link_libraries(cpu_benchmark
        pico_stdlib
)

pico_enable_stdio_usb(cpu_benchmark 0)
pico_enable_stdio_uart(cpu_benchmark 1)

pico_add_extra_outputs(cpu_benchmark)
