#include "quickgui.h"
void qg_process(void) {
  double mode = qg_input_number();
  qg_state_set("runs", qg_state_get("runs") + 1);
  qg_set_number("left", qg_get_number("left") + 1);
  if (mode == 1) qg_get_number("unknown");
  if (mode == 2) qg_set_number("locked", 99);
  if (mode == 3) qg_set_number("unknown", 99);
  if (mode == 4) qg_set_number("left", qg_input_number() / 0.0);
  qg_emit_number(qg_get_number("right"));
}
