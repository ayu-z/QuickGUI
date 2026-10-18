#include "quickgui.h"
/* Strings, arrays and structured connection results use the same JSON contract. */
void qg_process(void) {
    const char *input = qg_input_json();
    qg_log("JSON input processed by native C");
    qg_emit_json(input);
}
