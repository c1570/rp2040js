// C port of ntc-run.ts: a 5-chip co-simulation driving a Commodore 64 built from
// RP2040/RP2350 microcontrollers ("cnm64"), wired together via a virtual GPIO bus.
//
// Build: gcc -O3 -o demo/ntc-run demo/ntc-run.c -lm

#include "../build/transpile/rp2350js-c.h"

#include <inttypes.h>
#include <signal.h>
#include <string.h>

#define NUM_CHIPS 5
#define PIN_COUNT 9
#define MAIN_LOOP_STATS_CAP 1000
#define VIC_LOOP_STATS_CAP 1000
#define LOG_RING_CAP 5000

#define RP2350_SRAM_BYTES ((256 * 2 + 8) * 1024)

// ─── Chip abstraction ───────────────────────────────────────────────────
// Only 2 concrete chip kinds, both statically known (2x RP2350, 3x RP2040) — a tagged
// union with small inline dispatch helpers is simpler than a vtable here.
typedef struct {
  bool isRp2040;
  union {
    RP2040* rp2040;
    RP2350* rp2350;
  } u;
  const char* name;
  const char* hexPath;
  char tag[2][32]; // mcu_tags[mcuNumber][coreNumber], written by on_trace()
} Chip;

static Chip chips[NUM_CHIPS];

static inline int32_t chip_stepCores(Chip* c) {
  return c->isRp2040 ? RP2040_stepCores(c->u.rp2040) : RP2350_stepCores(c->u.rp2350);
}
static inline void chip_stepThings(Chip* c, int32_t n) {
  if (c->isRp2040)
    RP2040_stepThings(c->u.rp2040, n);
  else
    RP2350_stepThings(c->u.rp2350, n);
}
static inline int64_t chip_cycles(Chip* c) {
  return c->isRp2040 ? (int64_t)RP2040_cycles_get(c->u.rp2040) : RP2350_cycles_get(c->u.rp2350);
}
static inline int32_t chip_fdebug(Chip* c, int pio) {
  return c->isRp2040 ? c->u.rp2040->pio[pio]->fdebug : c->u.rp2350->pio[pio]->fdebug;
}
static inline GPIOPinState chip_gpio_inputValue(Chip* c, int pin) {
  return c->isRp2040 ? (GPIOPinState)GPIOPin__RP2040_inputValue_get(c->u.rp2040->gpio[pin])
                      : (GPIOPinState)GPIOPin_inputValue_get(c->u.rp2350->gpio[pin]);
}
static inline void chip_gpio_setInputValue(Chip* c, int pin, bool v) {
  if (c->isRp2040)
    GPIOPin__RP2040_setInputValue(c->u.rp2040->gpio[pin], v);
  else
    GPIOPin_setInputValue(c->u.rp2350->gpio[pin], v);
}
// Only MAIN/VIC (RP2350, riscv coreArch) use this — the fat ICpuCore pointer's `.obj`
// viewed as a concrete CPU*, same pattern as cts2c/helper-cts2c-ensure-parity.c.
static inline CPU* chip_riscv_core(Chip* c, int coreIdx) {
  return (CPU*)(c->u.rp2350->core[coreIdx].obj);
}

// ─── UART / trace callbacks (shared across all 5 chips) ────────────────
static void on_uart_byte(void* ctx, int32_t value) {
  (void)ctx;
  putchar((int)(value & 0xff));
}

static void on_trace(void* ctx, int32_t coreNumber, int32_t pc, const char* tag) {
  (void)pc;
  Chip* c = (Chip*)ctx;
  size_t n = sizeof(c->tag[0]) - 1;
  strncpy(c->tag[coreNumber], tag, n);
  c->tag[coreNumber][n] = '\0';
}

// ─── GPIO bus model ─────────────────────────────────────────────────────
// GPIO pins 2-10 ("clock", "d0".."d7") are cross-wired between all 5 chips to model a
// shared bidirectional bus. GPIOPinListener carries no context parameter, so each
// (chip, pin) pair needs its own static trampoline to recover identity (same technique
// demo/emulator-run.c uses for 1 chip x 11 pins, extended here to 5 chips x 9 pins).
static const int pin_gpio[PIN_COUNT] = {2, 3, 4, 5, 6, 7, 8, 9, 10};

static int pin_state_inp[NUM_CHIPS][PIN_COUNT];
static int pin_state_res[PIN_COUNT]; // 7-stage x2-bit shift pipeline (see exact_pin_tick)

#define GPIO_LISTENER(mcu, pin)                                                     \
  static void gpio_listener_##mcu##_##pin(GPIOPinState state, GPIOPinState oldState) { \
    (void)oldState;                                                                 \
    pin_state_inp[mcu][pin] = state;                                                \
  }
#define FOR_EACH_PIN(X, mcu) X(mcu, 0) X(mcu, 1) X(mcu, 2) X(mcu, 3) X(mcu, 4) X(mcu, 5) X(mcu, 6) X(mcu, 7) X(mcu, 8)
#define GEN_MCU_LISTENERS(mcu) FOR_EACH_PIN(GPIO_LISTENER, mcu)
GEN_MCU_LISTENERS(0)
GEN_MCU_LISTENERS(1)
GEN_MCU_LISTENERS(2)
GEN_MCU_LISTENERS(3)
GEN_MCU_LISTENERS(4)

#define LISTENER_ROW(mcu)                                                                    \
  {gpio_listener_##mcu##_0, gpio_listener_##mcu##_1, gpio_listener_##mcu##_2,                 \
   gpio_listener_##mcu##_3, gpio_listener_##mcu##_4, gpio_listener_##mcu##_5,                 \
   gpio_listener_##mcu##_6, gpio_listener_##mcu##_7, gpio_listener_##mcu##_8},

static GPIOPinListener gpio_listener_table[NUM_CHIPS][PIN_COUNT] = {
  LISTENER_ROW(0) LISTENER_ROW(1) LISTENER_ROW(2) LISTENER_ROW(3) LISTENER_ROW(4)};

// OR together every chip's 2-bit state for a pin, push it through a 7-cycle-latency
// shift pipeline, and on change, broadcast the new bus value to every chip's
// corresponding GPIO pin.
static void exact_pin_tick(void) {
  static const int stateMap[5] = {0b01, 0b10, 0b00, 0b00, 0b00}; // Low,High,Input,PullUp,PullDown
  const int latency = 7;
  for (int i = 0; i < PIN_COUNT; i++) {
    int v_in = 0;
    for (int mcu_id = 0; mcu_id < NUM_CHIPS; mcu_id++) v_in |= stateMap[pin_state_inp[mcu_id][i]];
    if (v_in == 0b00) v_in = (pin_state_res[i] >> (latency * 2)) & 0b11;
    pin_state_res[i] = pin_state_res[i] | (v_in << ((latency + 1) * 2));
    int v_old = pin_state_res[i] & 0b11;
    pin_state_res[i] = pin_state_res[i] >> 2;
    int v_new = pin_state_res[i] & 0b11;
    if (v_old != v_new) {
      bool tfv = (v_new & 0b01) == 0;
      for (int mcu_id = 0; mcu_id < NUM_CHIPS; mcu_id++)
        chip_gpio_setInputValue(&chips[mcu_id], pin_gpio[i], tfv);
    }
  }
}

// ─── Symbol offset lookup (see ntc-run.ts getVarOffs) ──────────────
static long get_var_offset(const char* elfMapPath, const char* varName) {
  FILE* f = fopen(elfMapPath, "r");
  if (!f) {
    fprintf(stderr, "Could not open map file %s\n", elfMapPath);
    exit(1);
  }
  char line[1024], line2[1024];
  while (fgets(line, sizeof line, f)) {
    if (strstr(line, varName)) {
      char* hexptr = strstr(line, "0x");
      if (!hexptr && fgets(line2, sizeof line2, f)) hexptr = strstr(line2, "0x");
      if (hexptr) {
        fclose(f);
        return strtol(hexptr, NULL, 16);
      }
    }
  }
  fclose(f);
  fprintf(stderr, "Could not find offset of variable %s in map file %s\n", varName, elfMapPath);
  exit(1);
}

static long framebuffer_off;
static long cpu_addr_off;

// ─── BMP snapshot writer ───────────────────────────
#define PIC_WIDTH 400
#define PIC_HEIGHT 300

static void write_pic(const char* filename) {
  static uint8_t pixels[PIC_WIDTH * PIC_HEIGHT];
  for (int i = 0; i < PIC_WIDTH * PIC_HEIGHT; i++)
    pixels[i] = (uint8_t)RP2040_readUint8(chips[2].u.rp2040, (uint32_t)(framebuffer_off + i));

  char tmp[512];
  snprintf(tmp, sizeof tmp, "%s_new", filename);
  FILE* f = fopen(tmp, "wb");
  if (!f) return;

  uint32_t fileSize = 54 + PIC_WIDTH * PIC_HEIGHT * 3;
  uint8_t hdr[54] = {0};
  hdr[0] = 'B';
  hdr[1] = 'M';
  memcpy(&hdr[2], &fileSize, 4);
  uint32_t dataOffset = 54;
  memcpy(&hdr[10], &dataOffset, 4);
  uint32_t infoSize = 40;
  memcpy(&hdr[14], &infoSize, 4);
  int32_t w = PIC_WIDTH, h = PIC_HEIGHT;
  memcpy(&hdr[18], &w, 4);
  memcpy(&hdr[22], &h, 4);
  uint16_t planes = 1, bpp = 24;
  memcpy(&hdr[26], &planes, 2);
  memcpy(&hdr[28], &bpp, 2);
  fwrite(hdr, 1, sizeof hdr, f);

  for (int row = PIC_HEIGHT - 1; row >= 0; row--) { // BMP rows are stored bottom-up
    for (int col = 0; col < PIC_WIDTH; col++) {
      uint8_t p = pixels[row * PIC_WIDTH + col];
      uint8_t bgr[3] = {(uint8_t)((p & 0x03) << 6), (uint8_t)((p & 0x1C) << 3), (uint8_t)(p & 0xE0)};
      fwrite(bgr, 1, 3, f);
    }
  }
  fclose(f);
  rename(tmp, filename);
}

// ─── Diagnostics: ring buffers + crash dump ────────────────────────────────────────────
typedef struct {
  int64_t startCycle, duration, idle, idle2;
  int vic_h, vic_l, addr6510;
  int64_t cycle6510;
} LoopStat;

static LoopStat main_loop_stats[MAIN_LOOP_STATS_CAP];
static long main_loop_stats_count = 0;
static LoopStat vic_loop_stats[VIC_LOOP_STATS_CAP];
static long vic_loop_stats_count = 0;

static inline void push_stat(LoopStat* ring, int cap, long* count, LoopStat s) {
  ring[(*count) % cap] = s;
  (*count)++;
}

static char log_ring[LOG_RING_CAP][256];
static long log_ring_count = 0;

static inline void log_line(const char* fmt, ...) {
  char* dst = log_ring[log_ring_count % LOG_RING_CAP];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(dst, sizeof log_ring[0], fmt, ap);
  va_end(ap);
  log_ring_count++;
}

// Diagnostic state used by log_state() / the main loop below.
static const char* bus_state_labels[5] = {"p1 ", "p2a", "p2b", "p3 ", "p4 "};
static int bus_state = -1;
static int64_t bus_cycle_start_at = 0;
static int64_t main_cycle_start_at = 0;
static int vic_h = 0, vic_l = 0;
static int64_t cycles_6510 = 0;
static char pTags[8][32];

// Mirrors ntc-run.ts's log_state(): one formatted diagnostic line per call, only used
// when do_tracing is on.
static void log_state(void) {
  int32_t cpu_addr = RP2350_readUint16(chips[0].u.rp2350, (uint32_t)cpu_addr_off);
  StateMachine* m_pio0_sm0 = chips[0].u.rp2350->pio[0]->machines[0];
  StateMachine* v_pio1_sm0 = chips[1].u.rp2350->pio[1]->machines[0];
  StateMachine* v_pio1_sm1 = chips[1].u.rp2350->pio[1]->machines[1];
  StateMachine__RP2040* o_pio1_sm0 = chips[2].u.rp2040->pio[1]->machines[0];

  char pTags_updated[8][32];
  snprintf(pTags_updated[0], sizeof pTags_updated[0], "%s", chips[0].tag[0]);
  snprintf(pTags_updated[1], sizeof pTags_updated[1], "%s", chips[0].tag[1]);
  snprintf(pTags_updated[2], sizeof pTags_updated[2], "%s", chips[1].tag[0]);
  snprintf(pTags_updated[3], sizeof pTags_updated[3], "%s", chips[1].tag[1]);
  snprintf(pTags_updated[4], sizeof pTags_updated[4], "%d", m_pio0_sm0->pc);
  snprintf(pTags_updated[5], sizeof pTags_updated[5], "%d", v_pio1_sm0->pc);
  snprintf(pTags_updated[6], sizeof pTags_updated[6], "%d", v_pio1_sm1->pc);
  snprintf(pTags_updated[7], sizeof pTags_updated[7], "%d", o_pio1_sm0->pc);

  int32_t pInstrs[8] = {
    0, 0, 0, 0,
    chips[0].u.rp2350->pio[0]->instructions[m_pio0_sm0->pc],
    chips[1].u.rp2350->pio[1]->instructions[v_pio1_sm0->pc],
    chips[1].u.rp2350->pio[1]->instructions[v_pio1_sm1->pc],
    chips[2].u.rp2040->pio[1]->instructions[o_pio1_sm0->pc],
  };

  // Sized well past the 32-byte source strings so gcc's format-truncation checker (which
  // otherwise assumes an unbounded %s) can prove these snprintf calls never truncate.
  char wTags[8][300];
  for (int i = 0; i < 4; i++) {
    if (strcmp(pTags_updated[i], pTags[i]) == 0)
      snprintf(wTags[i], sizeof wTags[i], "%-18s", "...");
    else
      snprintf(wTags[i], sizeof wTags[i], "%-18s", pTags_updated[i]);
  }
  for (int i = 4; i < 8; i++) {
    if (strcmp(pTags_updated[i], pTags[i]) == 0) {
      snprintf(wTags[i], sizeof wTags[i], "~~ ");
    } else {
      char instrAnn = ' ';
      int32_t opcPar = pInstrs[i] & 0b1110000011100000;
      if (opcPar == 0b0100000000000000)
        instrAnn = 'i'; // IN PINS
      else if (opcPar == 0b0110000000000000)
        instrAnn = 'o'; // OUT PINS
      else if (opcPar == 0b0110000010000000)
        instrAnn = 'd'; // OUT PINDIRS
      int pc = i == 4   ? m_pio0_sm0->pc
               : i == 5 ? v_pio1_sm0->pc
               : i == 6 ? v_pio1_sm1->pc
                        : o_pio1_sm0->pc;
      snprintf(wTags[i], sizeof wTags[i], "%02d%c", pc, instrAnn);
    }
  }
  memcpy(pTags, pTags_updated, sizeof pTags);

  CPU* main_c0 = chip_riscv_core(&chips[0], 0);
  CPU* main_c1 = chip_riscv_core(&chips[0], 1);
  CPU* vic_c0 = chip_riscv_core(&chips[1], 0);
  CPU* vic_c1 = chip_riscv_core(&chips[1], 1);

  char cycleTag[16];
  if (main_c0->cycles == main_cycle_start_at)
    snprintf(cycleTag, sizeof cycleTag, "%10" PRId64, main_c0->cycles);
  else {
    char plus[16];
    snprintf(plus, sizeof plus, "+%" PRId64, main_c0->cycles - main_cycle_start_at);
    snprintf(cycleTag, sizeof cycleTag, "%10s", plus);
  }
  char busTag[8];
  snprintf(busTag, sizeof busTag, "%3" PRId64, main_c0->cycles - bus_cycle_start_at);
  const char* bus_state_str = bus_state >= 0 ? bus_state_labels[bus_state] : "---";

  char bus_pins[16] = "";
  int bus_bin = 0;
  for (int i = 8; i > 0; i--) {
    int bus_pin = (int)chip_gpio_inputValue(&chips[2], pin_gpio[i]) != 0;
    bus_bin = (bus_bin << 1) + bus_pin;
    char c[2] = {(char)('0' + bus_pin), '\0'};
    strcat(bus_pins, c);
  }
  char bus_pins_full[24];
  snprintf(bus_pins_full, sizeof bus_pins_full, "%d %s",
           (int)chip_gpio_inputValue(&chips[2], pin_gpio[0]) != 0, bus_pins);

  log_line(
    "%s / %s | %s | M %08x/%s %08x/%s | V %08x/%s %08x/%s | M_PIO@%s V_PIO@%s/r%d/t%d "
    "V_OUT@%s O_INP@%s | V_H_COUNT@%02d 6510@%04x %s %02x",
    cycleTag, busTag, bus_state_str, (uint32_t)main_c0->pc, wTags[0], (uint32_t)main_c1->pc,
    wTags[1], (uint32_t)vic_c0->pc, wTags[2], (uint32_t)vic_c1->pc, wTags[3], wTags[4], wTags[5],
    FIFO_itemCount_get(v_pio1_sm0->rxFIFO), FIFO_itemCount_get(v_pio1_sm0->txFIFO), wTags[6],
    wTags[7], vic_h, (uint32_t)cpu_addr, bus_pins_full, (unsigned)bus_bin);
}

// ─── Stop / control-flow handling (replaces ntc-run.ts's throw/catch dance) ────────────
typedef enum {
  STOP_NONE = 0,
  STOP_SIGINT,
  STOP_QUIT_TAG,
  STOP_DEBUG_CYCLE_LIMIT,
  STOP_PIO_TX_STALL,
  STOP_PIO_TX_OVERFLOW,
  STOP_PIO_RX_UNDERFLOW,
} StopReason;

static StopReason stop_reason = STOP_NONE;
static char stop_message[256];

static volatile sig_atomic_t got_sigint = 0;
static void sigint_handler(int sig) {
  (void)sig;
  got_sigint = 1;
}

static void dump_and_exit(void) {
  log_line("*** Exception %s - try running with CNM64_RUN_TO_CYCLE=%" PRId64 " ***", stop_message,
           chip_cycles(&chips[0]));
  log_state();

  long n = log_ring_count < LOG_RING_CAP ? log_ring_count : LOG_RING_CAP;
  for (long k = 0; k < n; k++) {
    long idx = (log_ring_count - n + k) % LOG_RING_CAP;
    fprintf(stderr, "%s\n", log_ring[idx]);
  }

  fprintf(stderr, "\n*** 6510 statistics ***\n");
  {
    long n2 = main_loop_stats_count < MAIN_LOOP_STATS_CAP ? main_loop_stats_count : MAIN_LOOP_STATS_CAP;
    for (long k = 0; k < n2; k++) {
      LoopStat* l = &main_loop_stats[(main_loop_stats_count - n2 + k) % MAIN_LOOP_STATS_CAP];
      fprintf(stderr,
              "6510 cycle %" PRId64 ", ARM cycle %" PRId64 ", MAIN total/idle %" PRId64 "/%" PRId64
              " cycles, core1 idle %" PRId64 " cycles, bus addr %04x, vic_l %d, vic_h %d\n",
              l->cycle6510, l->startCycle, l->duration, l->idle, l->idle2, (unsigned)l->addr6510,
              l->vic_l, l->vic_h);
    }
  }
  fprintf(stderr, "\n*** VIC-II statistics ***\n");
  {
    long n2 = vic_loop_stats_count < VIC_LOOP_STATS_CAP ? vic_loop_stats_count : VIC_LOOP_STATS_CAP;
    for (long k = 0; k < n2; k++) {
      LoopStat* l = &vic_loop_stats[(vic_loop_stats_count - n2 + k) % VIC_LOOP_STATS_CAP];
      fprintf(stderr,
              "6510 cycle %" PRId64 ", ARM cycle %" PRId64 ", VIC tick/idle %" PRId64 "/%" PRId64
              " cycles, render idle %" PRId64 " cycles, vic_l %d, vic_h %d\n",
              l->cycle6510, l->startCycle, l->duration, l->idle, l->idle2, l->vic_l, l->vic_h);
    }
  }

  FILE* f = fopen("/tmp/rp2040_crash.bin", "wb");
  if (f) {
    fwrite(chips[0].u.rp2350->sram, 1, RP2350_SRAM_BYTES, f);
    fclose(f);
  }

  write_pic("/tmp/cnm64.bmp");

  bool graceful =
    stop_reason == STOP_SIGINT || stop_reason == STOP_QUIT_TAG || stop_reason == STOP_DEBUG_CYCLE_LIMIT;
  exit(graceful ? 0 : 1);
}

// ─── Main ───────────────────────────────────────────────────────────────
int main(void) {
  static const char* cnm_names[NUM_CHIPS] = {"MAIN", "VIC", "OUTPUT", "CIA1", "CIA2"};
  static const char* cnm_files[NUM_CHIPS] = {
    "../cnm/cnm64_main.hex", "../cnm/cnm64_vic.hex", "../cnm/cnm64_output.hex",
    "../cnm/cnm64_cia1.hex", "../cnm/cnm64_cia2.hex"};

  for (int i = 0; i < NUM_CHIPS; i++) {
    Chip* c = &chips[i];
    c->name = cnm_names[i];
    c->hexPath = cnm_files[i];
    c->isRp2040 = i >= 2;
    if (c->isRp2040) {
      RP2040Options options = {.loadFirmware = NULL};
      c->u.rp2040 = RP2040_new(&options);
      LoadFirmwareOptions lfo = {.entryPc = 0x10000000};
      RP2040_loadFirmware(c->u.rp2040, c->hexPath, &lfo);
      c->u.rp2040->core[1]->waiting = true;
      c->u.rp2040->uart[0]->onByte_fn = on_uart_byte;
      c->u.rp2040->onTrace_fn = on_trace;
      c->u.rp2040->onTrace_ctx = c;
    } else {
      RP2350Options options = {.loadFirmware = NULL};
      c->u.rp2350 = RP2350_new(&options);
      char* hexText = readFileSync(c->hexPath, "utf-8");
      loadFirmwareFromHex__RP2350(c->u.rp2350, hexText, c->hexPath);
      RP2350_reset(c->u.rp2350, false);
      chip_riscv_core(c, 0)->pc = 0x10000036;
      chip_riscv_core(c, 1)->pc = 0x10000036;
      c->u.rp2350->uart[0]->onByte_fn = on_uart_byte;
      c->u.rp2350->onTrace_fn = on_trace;
      c->u.rp2350->onTrace_ctx = c;
    }
  }

  // Wire the 9 shared-bus pins between all 5 chips, plus default pull-up on unused pins.
  for (int i = 0; i < PIN_COUNT; i++) {
    pin_state_inp[0][i] = pin_state_inp[1][i] = pin_state_inp[2][i] = pin_state_inp[3][i] =
      pin_state_inp[4][i] = GPIOPinState_InputPullUp;
    for (int mcu_id = 0; mcu_id < NUM_CHIPS; mcu_id++) {
      Chip* c = &chips[mcu_id];
      int gp = pin_gpio[i];
      if (c->isRp2040)
        GPIOPin__RP2040_addListener(c->u.rp2040->gpio[gp], gpio_listener_table[mcu_id][i]);
      else
        GPIOPin_addListener(c->u.rp2350->gpio[gp], gpio_listener_table[mcu_id][i]);
    }
  }
  for (int mcu_id = 0; mcu_id < NUM_CHIPS; mcu_id++) {
    Chip* c = &chips[mcu_id];
    int gpioCount = c->isRp2040 ? 30 : 48;
    for (int i = 11; i < gpioCount; i++) chip_gpio_setInputValue(c, i, true);
    chip_gpio_setInputValue(c, 0, true);
    chip_gpio_setInputValue(c, 1, true);
  }

  cpu_addr_off = get_var_offset("../cnm/cnm64_main.elf.map", ".sbss.addr");
  framebuffer_off = get_var_offset("../cnm/cnm64_output.elf.map", ".bss.frame_buffer");

  signal(SIGINT, sigint_handler);

  double mcu_cycles_behind[NUM_CHIPS] = {0};
  double pio_cycles_behind[NUM_CHIPS] = {0};
  int64_t main_idle_cycles = 0, main_idle2_cycles = 0;
  int64_t vic_idle_cycles = 0, render_idle_cycles = 0;
  int64_t vic_cycle_start_at = 0;
  int vic_cycle_state = -1;
  int clock_pin_state = 0;
  int64_t next_cycle_time_output = 0;
  int32_t main_cycle_start_off = 0;
  bool do_tracing = false;
  const char* env;
  int64_t debug_crash_cycle = (env = getenv("CNM64_RUN_TO_CYCLE")) ? atol(env) : 0;
  int64_t debug_trace_from_emu_cycle = (env = getenv("CNM64_TRACE_FROM_EMU_CYCLE")) ? atol(env) : 0;
  int32_t debug_trace_from_emu_addr = (env = getenv("CNM64_TRACE_FROM_EMU_ADDR")) ? (int32_t)atol(env) : 0;

  for (;;) {
    int64_t main_cycles_now = chip_cycles(&chips[0]);
    if (main_cycles_now > next_cycle_time_output) {
      write_pic("/tmp/cnm64.bmp");
      next_cycle_time_output += 4000000;
      printf("clock: %g secs\n", ((double)(main_cycles_now / 40000000)) / 10.0);
      fflush(stdout);
    }

    int32_t cycles_consumed = chip_stepCores(&chips[0]);
    pio_cycles_behind[0] += cycles_consumed;
    if (chips[0].tag[0][0] == '*') main_idle_cycles += cycles_consumed;
    if (chips[0].tag[1][0] == '*') main_idle2_cycles += cycles_consumed;

    for (int mcu_id = 1; mcu_id < NUM_CHIPS; mcu_id++) {
      double cycles_for_mcu =
        (mcu_id != 2) ? (double)cycles_consumed : (double)cycles_consumed * (295.0 / 400.0);
      mcu_cycles_behind[mcu_id] += cycles_for_mcu;
      pio_cycles_behind[mcu_id] += cycles_for_mcu;
      while (mcu_cycles_behind[mcu_id] > 0) {
        int32_t cycles_mcu = chip_stepCores(&chips[mcu_id]);
        mcu_cycles_behind[mcu_id] -= (double)cycles_mcu;
        if (mcu_id == 1) {
          if (chips[1].tag[0][0] == '*') vic_idle_cycles += cycles_mcu;
          if (chips[1].tag[1][0] == '*') render_idle_cycles += cycles_mcu;
          if (vic_cycle_state != 0 && strcmp(chips[1].tag[0], "^vic tick") == 0) {
            vic_cycle_state = 0;
            vic_cycle_start_at = chip_cycles(&chips[1]);
          } else if (vic_cycle_state != 1 && strcmp(chips[1].tag[0], "$vic tick") == 0) {
            vic_cycle_state = 1;
            LoopStat s = {.startCycle = vic_cycle_start_at,
                          .duration = chip_cycles(&chips[1]) - vic_cycle_start_at,
                          .vic_h = vic_h,
                          .vic_l = vic_l,
                          .cycle6510 = cycles_6510,
                          .idle = vic_idle_cycles,
                          .idle2 = render_idle_cycles,
                          .addr6510 = 0};
            push_stat(vic_loop_stats, VIC_LOOP_STATS_CAP, &vic_loop_stats_count, s);
            vic_idle_cycles = 0;
            render_idle_cycles = 0;
          }
        }
      }
    }

    for (int32_t pCycles = 0; pCycles < cycles_consumed; pCycles++) {
      int cur_clock_pin_state = chip_gpio_inputValue(&chips[2], pin_gpio[0]) != 0;
      if (cur_clock_pin_state != clock_pin_state) {
        if (cur_clock_pin_state == 1) {
          bus_state = (bus_state + 1) % 5;
          if (bus_state == 0) bus_cycle_start_at = main_cycles_now;
        }
        clock_pin_state = cur_clock_pin_state;
      }

      for (int mcu_id = 0; mcu_id < NUM_CHIPS; mcu_id++) {
        if (pio_cycles_behind[mcu_id] > 0) {
          pio_cycles_behind[mcu_id] -= 1;
          chip_stepThings(&chips[mcu_id], 1);
        }
      }
      exact_pin_tick();
    }

    for (int mcu_id = 0; mcu_id < NUM_CHIPS && stop_reason == STOP_NONE; mcu_id++) {
      for (int pio = 0; pio <= 1; pio++) {
        if (mcu_id == 1 && pio == 0) continue; // ignore VIC gfx pio
        if (mcu_id == 2 && pio == 1) continue;
        int32_t pio_fdebug = chip_fdebug(&chips[mcu_id], pio);
        if (pio_fdebug & 0x0f0f0f00) {
          if (mcu_id != 0 && (pio_fdebug & 0x0f000000)) {
            stop_reason = STOP_PIO_TX_STALL;
            snprintf(stop_message, sizeof stop_message, "%s PIO %d TX STALL: %d", chips[mcu_id].name,
                     pio, (pio_fdebug >> 24) & 15);
          } else if (pio_fdebug & 0x000f0000) {
            stop_reason = STOP_PIO_TX_OVERFLOW;
            snprintf(stop_message, sizeof stop_message, "%s PIO %d TX OVERFLOW: %d", chips[mcu_id].name,
                     pio, (pio_fdebug >> 16) & 15);
          } else if (pio_fdebug & 0x00000f00) {
            stop_reason = STOP_PIO_RX_UNDERFLOW;
            snprintf(stop_message, sizeof stop_message, "%s PIO %d RX UNDERFLOW: %d", chips[mcu_id].name,
                     pio, (pio_fdebug >> 8) & 15);
          }
        }
      }
    }
    if (stop_reason != STOP_NONE) dump_and_exit();

    int32_t main_pc = chip_riscv_core(&chips[0], 0)->pc;
    if (main_cycle_start_off == 0 && strcmp(chips[0].tag[0], "cycle start") == 0) {
      main_cycle_start_off = main_pc;
      main_cycle_start_at = chip_cycles(&chips[0]);
    } else if (main_pc == main_cycle_start_off) {
      int32_t addr6510 = (int32_t)RP2350_readUint16(chips[0].u.rp2350, (uint32_t)cpu_addr_off);
      LoopStat s = {.startCycle = main_cycle_start_at,
                    .duration = chip_cycles(&chips[0]) - main_cycle_start_at,
                    .idle = main_idle_cycles,
                    .idle2 = main_idle2_cycles,
                    .vic_h = vic_h,
                    .vic_l = vic_l,
                    .addr6510 = addr6510,
                    .cycle6510 = cycles_6510};
      push_stat(main_loop_stats, MAIN_LOOP_STATS_CAP, &main_loop_stats_count, s);
      cycles_6510++;
      main_idle_cycles = 0;
      main_idle2_cycles = 0;
      vic_h++;
      if (vic_h > 62) {
        vic_h = 0;
        vic_l++;
        if (vic_l >= 312) vic_l = 0;
      }
      main_cycle_start_at = chip_cycles(&chips[0]);
    } else if (strcmp(chips[0].tag[0], "_quit") == 0) {
      stop_reason = STOP_QUIT_TAG;
      snprintf(stop_message, sizeof stop_message, "Debug encountered _quit");
      dump_and_exit();
    }

    int32_t addr6510_now = (int32_t)RP2350_readUint16(chips[0].u.rp2350, (uint32_t)cpu_addr_off);
    if (do_tracing) {
      log_state();
      if (debug_crash_cycle > 0 && chip_cycles(&chips[0]) > debug_crash_cycle) {
        stop_reason = STOP_DEBUG_CYCLE_LIMIT;
        snprintf(stop_message, sizeof stop_message, "Debug end tracing");
        dump_and_exit();
      }
    } else {
      if (debug_crash_cycle > 0 && chip_cycles(&chips[0]) > debug_crash_cycle - 10000) do_tracing = true;
      if (debug_trace_from_emu_cycle > 0 && cycles_6510 > debug_trace_from_emu_cycle) {
        do_tracing = true;
        debug_crash_cycle = chip_cycles(&chips[0]) + 4200;
      }
      if (debug_trace_from_emu_addr > 0 && addr6510_now == debug_trace_from_emu_addr) {
        do_tracing = true;
        debug_crash_cycle = chip_cycles(&chips[0]) + 4200;
      }
    }

    if (got_sigint) {
      stop_reason = STOP_SIGINT;
      snprintf(stop_message, sizeof stop_message, "Debug caught sigint");
      dump_and_exit();
    }
  }
}
