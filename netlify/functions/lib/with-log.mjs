// The wrapper every function's handler runs in (#925, phase 2): its
// lines ship after it answers, a crash raises one alert, and a slow or
// failing answer gets one line. Moved out of lib/log.mjs, so log.mjs
// imports nothing; the lines still go into log.mjs's one buffer,
// through its `line`.

import { within } from "./clock.mjs";
import { SLOW_MS, flush, line, testOf, trimStack } from "./log.mjs";

// The alert for an exception no handler caught, through lib/health.mjs
// (imported here when needed, so a function's cold start does not load
// health.mjs and all it imports, only a crash does). Its
// hourly limit is per function, so one noisy function cannot hide
// another's crash. `options` are alert()'s, for the tests.
export const alertCrash = async (detail, error, {
  stores: given, ...options
} = {}) => {
  const [{ alert }, { stores }] = await Promise.all([
    import("./health.mjs"), import("./store.mjs"),
  ]);

  const s = given || stores();

  return alert(s, "function.crashed", detail, {
    ...options, mute: `function.crashed/${detail.function}`,
  });
};

// -> the request's path and method, or nulls for a scheduled run.
const where = (req) => {
  try {
    return { method: req.method || null, path: new URL(req.url).pathname };
  } catch {
    return { method: null, path: null };
  }
};

// Wraps a function handler so its lines ship after it answers,
// whatever happened inside. An exception the handler did not catch is
// logged as function.crashed with the function's name and a trimmed
// stack, raises one alert (`onCrash`), and is thrown on unchanged, so
// Netlify answers exactly as it would have. The report never fails
// the request: a failing onCrash is logged and dropped. An answer
// slower than SLOW_MS or with a 5xx status is logged as
// function.slow, with the path (never the query) and the e2e test it
// came from, so a failed staging run can find its own lines.
//
//   withLog("orders", handler)
//   withLog("orders", handler, { onCrash, flushImpl })
export const withLog = (name, handler, {
  onCrash = alertCrash,
  flushImpl = flush,
  now = Date.now,
} = {}) => {
  if (typeof name === "function") return withLog("unnamed", name, handler);

  return async (req, context) => {
    const started = now();

    try {
      const res = await within(req, () => handler(req, context));
      const ms = now() - started;
      const status = res && typeof res.status === "number" ? res.status : null;

      if (ms >= SLOW_MS || (status !== null && status >= 500)) {
        line("warn", {
          event: "function.slow", function: name, ...where(req), status,
          ms, test: testOf(req),
        });
      }

      return res;
    } catch (error) {
      let path = null;

      try {
        path = new URL(req.url).pathname;
      } catch {
        // A scheduled run has no request.
      }

      const detail = {
        function: name,
        error: String((error && error.message) || error).slice(0, 300),
        method: (req && req.method) || null,
        path,
        stack: trimStack(error),
      };

      line("error", { event: "function.crashed", ...detail });
      if (onCrash) {
        try {
          await onCrash(detail, error);
        } catch (failure) {
          line("error", {
            event: "function.crash_alert_failed", function: name,
            error: String(failure),
          });
        }
      }

      throw error;
    } finally {
      await flushImpl();
    }
  };
};
