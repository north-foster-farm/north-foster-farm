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
  if (process.env.NODE_TEST_CONTEXT && fetchImpl === globalThis.fetch) {
    return 0;
  }

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

// Wraps a function handler so its lines ship after it answers,
// whatever happened inside.
export const withLog = (handler) => async (req, context) => {
  try {
    return await handler(req, context);
  } finally {
    await flush();
  }
};
