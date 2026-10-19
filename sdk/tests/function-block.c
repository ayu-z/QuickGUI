#include "quickgui.h"
/* Integer FB fixture: no external C-library symbols are needed by the JIT.
 * Inputs are the flat, typed numeric fields a/b supplied by the test graph. */
static long argument(const char *json, char key) {
    long value = 0;
    int sign = 1;
    const char *p = json;
    while (*p) {
        if (*p == '"' && p[1] == key && p[2] == '"') {
            p += 3;
            while (*p == ' ' || *p == ':') ++p;
            if (*p == '-') { sign = -1; ++p; }
            while (*p >= '0' && *p <= '9') { value = value * 10 + (*p - '0'); ++p; }
            return value * sign;
        }
        ++p;
    }
    return 0;
}
static char *text(char *out, const char *value) {
    while (*value) *out++ = *value++;
    return out;
}
static char *number(char *out, long value) {
    char digits[24];
    int count = 0;
    if (value < 0) { *out++ = '-'; value = -value; }
    do { digits[count++] = (char)('0' + value % 10); value /= 10; } while (value);
    while (count) *out++ = digits[--count];
    return out;
}
void qg_process(void) {
    const char *input = qg_input_json();
    long a = argument(input, 'a');
    long b = argument(input, 'b');
    long runs = (long)qg_state_get("runs") + 1;
    char result[256];
    char *out = result;
    qg_state_set("runs", runs);
    out = text(out, "{\"sum\":"); out = number(out, a + b);
    out = text(out, ",\"difference\":"); out = number(out, a - b);
    out = text(out, ",\"runs\":"); out = number(out, runs);
    *out++ = '}'; *out = 0;
    qg_emit_json(result);
}
