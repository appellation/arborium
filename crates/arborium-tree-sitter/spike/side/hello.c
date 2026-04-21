#include <stdint.h>

struct TSParser;
typedef struct TSParser TSParser;

extern TSParser *ts_parser_new(void);
extern void ts_parser_delete(TSParser *self);
extern void ts_parser_reset(TSParser *self);

__attribute__((visibility("default")))
uintptr_t try_ts(void) {
    TSParser *p = ts_parser_new();
    if (!p) return 0;
    ts_parser_reset(p);
    uintptr_t addr = (uintptr_t)p;
    ts_parser_delete(p);
    return addr;
}
