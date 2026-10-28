// The end of a bin/nff run (#496): the lines it logged go to the log
// store, as a function's do, so a production removal or deletion is on
// record after the terminal closes. They are already scrubbed, and a
// line that names a customer carries the address masked (lib/mask.mjs).
// A dry run changed nothing, so it ships nothing and its lines are
// dropped. Without AXIOM_TOKEN and AXIOM_DATASET (development) nothing
// is shipped either. -> how many lines were sent.

import { flush } from "../netlify/functions/lib/log.mjs";

export const shipLog = ({
  dryRun = false, env = process.env, fetchImpl = globalThis.fetch,
} = {}) => flush({ env: dryRun ? {} : env, fetchImpl, source: "cli" });
