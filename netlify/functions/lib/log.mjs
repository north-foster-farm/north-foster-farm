// One JSON line per event, as the functions have always written to
// the console, and the same lines shipped to a log store that outlives
// the function and the deploy, so "when did this start" has an
// answer. Each invocation buffers its lines and ships them once, at
// the end, with a short timeout; the store being down changes nothing
// for the request.
//
//   AXIOM_TOKEN, AXIOM_DATASET   the store (api.axiom.co). Unset: the
//                                lines go to the console only.
//
// Under `node --test` nothing is shipped, like sendMail.

const buffer = [];

const SHIP_TIMEOUT = 1500;

const line = (level, fields) => {
  const record = {
    _time: new Date().toISOString(),
    level,
    ...(fields && typeof fields === "object" ? fields : { message: fields }),
  };
  const out = level === "error" ? console.error
    : level === "warn" ? console.warn : console.info;

  out(JSON.stringify(record));
  buffer.push(record);

  return record;
};

export const log = {
  info: (fields) => line("info", fields),
  warn: (fields) => line("warn", fields),
  error: (fields) => line("error", fields),
};

export const pending = () => buffer.length;

export const configured = (env = process.env) =>
  !!(env.AXIOM_TOKEN && env.AXIOM_DATASET);

// Ships what is buffered and empties the buffer. -> how many lines
// were sent (0 when the store is not configured or refused them).
export const flush = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  source = "site",
} = {}) => {
  const lines = buffer.splice(0, buffer.length);

  if (!lines.length || !configured(env)) return 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHIP_TIMEOUT);

  const dataset = encodeURIComponent(env.AXIOM_DATASET);

  try {
    const res = await fetchImpl(
      `https://api.axiom.co/v1/datasets/${dataset}/ingest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AXIOM_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(lines.map((l) => ({
          ...l, source, deploy: env.DEPLOY_ID || env.CONTEXT || null,
        }))),
        signal: controller.signal,
      }
    );

    return res.ok ? lines.length : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
};

const STACK_LINES = 12;
const STACK_CHARS = 2000;

// A stack short enough for a log line and an alert: the message and
// the first frames, which name the file and line that threw.
export const trimStack = (error) => String((error && error.stack)
  || error).split("\n").slice(0, STACK_LINES).join("\n")
  .slice(0, STACK_CHARS);

// The alert for an exception no handler caught, through lib/health.mjs
// (imported here when needed, since it logs through this module). Its
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

// Wraps a function handler so its lines ship after it answers,
// whatever happened inside. An exception the handler did not catch is
// logged as function.crashed with the function's name and a trimmed
// stack, raises one alert (`onCrash`), and is thrown on unchanged, so
// Netlify answers exactly as it would have. The report never fails
// the request: a failing onCrash is logged and dropped.
//
//   withLog("orders", handler)
//   withLog("orders", handler, { onCrash, flushImpl })
export const withLog = (name, handler, {
  onCrash = alertCrash,
  flushImpl = flush,
} = {}) => {
  if (typeof name === "function") return withLog("unnamed", name, handler);

  return async (req, context) => {
    try {
      return await handler(req, context);
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
