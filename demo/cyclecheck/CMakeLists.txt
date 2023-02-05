cmake_minimum_required(VERSION 3.12)
include(pico_sdk_import.cmake)

project(cyclecheck C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

#add_definitions(-DPICO_TIME_DEFAULT_ALARM_POOL_DISABLED)

pico_sdk_init()

add_executable(cyclecheck
        cyclecheck.c
)

target_compile_options(cyclecheck PRIVATE -Wall)

target_link_libraries(cyclecheck
        pico_stdlib
        pico_util
)

pico_enable_stdio_usb(cyclecheck 0)
pico_enable_stdio_uart(cyclecheck 1)

pico_add_extra_outputs(cyclecheck)
