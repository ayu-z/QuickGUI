#ifndef QUICKGUI_HOST_API_H
#define QUICKGUI_HOST_API_H
/* QuickGUI host ABI v2 (existing numeric calls remain compatible).
 * Keys/log messages are UTF-8, NUL-terminated, <=4096 bytes.
 * State and variable values must be finite numbers. All calls are synchronous
 * and confined to the worker thread. The engine validates writes atomically.
 * No ownership of pointers crosses this API or the process boundary. */
#define QUICKGUI_HOST_ABI_VERSION 2
#ifdef __cplusplus
extern "C" {
#endif
double qg_input_number(void);
/* Input pointers are read-only and valid for this qg_process invocation only.
 * JSON text handles every JSON type. String input requires a JSON string with
 * no embedded NUL. A wrong typed accessor records a host error for the call. */
const char *qg_input_json(void);
const char *qg_input_string(void);
double qg_get_number(const char *name);
void qg_set_number(const char *name, double value);
void qg_emit_number(double value);
/* Emission copies the string/JSON immediately. Limit: 1 MiB of UTF-8 text. */
void qg_emit_json(const char *json);
void qg_emit_string(const char *value);
void qg_log(const char *message);
double qg_state_get(const char *name);
void qg_state_set(const char *name, double value);
void qg_process(void);
#ifdef __cplusplus
}
#endif
#endif
