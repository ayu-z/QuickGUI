#include "quickgui.h"
void qg_process(void) {
    double runs = qg_state_get("runs") + 1;
    qg_state_set("runs", runs);
    qg_emit_number(qg_input_number() * 3);
    qg_log("C self-test");
}
