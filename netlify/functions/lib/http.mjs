// Small helpers shared by the functions.

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

export const readJson = async (req) => {
  try {
    return await req.json();
  } catch {
    return null;
  }
};

// How long the order request may run before it answers, with room left
// under Netlify's 10 s limit for writing the record. The processor
// calls on the order path share it (`allow`), so a slow first call
// shortens the next and a retry is not begun that cannot finish.
export const ORDER_BUDGET_MS = 8000;

// Under this much time left a call is not started. A call that moves
// money has a floor of its own (`floor`): started with less, it would
// almost surely be cut off after the card was sent, leaving a payment
// nobody has an answer for. Refused, it charges nothing at all.
export const MIN_CALL_MS = 300;
export const MONEY_FLOOR_MS = 2000;

// The time one outbound call may take: its own cap, or what is left of
// the request's `deadline` (a Date.now() value) if that is less.
export const allow = (cap, deadline) => (deadline
  ? Math.min(cap, deadline - Date.now())
  : cap);

export const timedOut = (error) => !!error
  && (error.name === "TimeoutError" || error.name === "AbortError");

// A fetch with a timeout that covers the body too. A call that does not
// answer in time throws `fail(message, detail)` marked retryable with
// the code "timeout": the caller cannot know whether the other side
// acted, which is why a payment is always sent under an idempotency key.
// -> the response, or throws.
export const timedFetch = async (fetchImpl, url, init, {
  cap, deadline, name, fail, floor = MIN_CALL_MS,
}) => {
  const ms = allow(cap, deadline);

  if (ms < floor) {
    throw fail(`No time left to call ${name}`, {
      retryable: true, code: "timeout", detail: "request budget spent",
    });
  }

  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    throw fail(timedOut(error)
      ? `${name} did not answer in ${Math.round(ms / 100) / 10} s`
      : `Network error calling ${name}`, {
      retryable: true,
      code: timedOut(error) ? "timeout" : null,
      detail: String(error),
    });
  }
};

// Bounded retry for transient failures only. `sleep` is injectable so
// tests do not wait. `until` (a Date.now() value) ends the retrying
// when the next try could not finish before it.
export const retry = async (fn, {
  attempts = 3,
  delays = [500, 1500],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  until = 0,
} = {}) => {
  let last;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (error) {
      last = error;

      if (!error || !error.retryable || i === attempts - 1) throw error;

      const delay = delays[Math.min(i, delays.length - 1)];

      if (until && Date.now() + delay + MIN_CALL_MS > until) throw error;

      await sleep(delay);
    }
  }

  throw last;
};
