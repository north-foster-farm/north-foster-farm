// A broken scrub, seeded on purpose for log-clock.test.mjs (#999,
// #1005's QA review): loaded before a test file with
// `--import ./test/seed-time-scrub.mjs`, it rewrites lib/log.mjs as it
// loads so that line() puts a caller's string `_time` back on the
// record unscrubbed, as a scrub that skipped `_time` would. Nothing
// else in the logger changes. The site's code on disk is untouched.
// If the line it hooks on is gone, it throws, so the proof cannot
// quietly turn into a run of the real scrub.

import { registerHooks } from "node:module";

const ANCHOR = "  out(JSON.stringify(record));";
const SEED = "  if (typeof fields?._time === \"string\") {\n"
  + "    record._time = fields._time;\n  }\n";

registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);

    if (!url.endsWith("/netlify/functions/lib/log.mjs")) return loaded;

    const source = String(loaded.source);

    if (!source.includes(ANCHOR)) {
      throw new Error(`seed-time-scrub.mjs: no "${ANCHOR}" in log.mjs`);
    }

    return { ...loaded, source: source.replace(ANCHOR, SEED + ANCHOR) };
  },
});
