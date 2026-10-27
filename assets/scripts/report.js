// The order page's error reporter (#246; report/reporter.mjs says what
// it does). Built on its own and loaded in <head>, before the order
// bundle, so a crash in the bundle is still caught. Its fields are
// defined in report/fields.mjs alone (#258).

import { install } from "./report/reporter.mjs";

try {
  install(globalThis);
} catch {
  // Nothing reported, nothing broken.
}
