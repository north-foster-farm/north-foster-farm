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

// Bounded retry for transient failures only. `sleep` is injectable so
// tests do not wait.
export const retry = async (fn, {
  attempts = 3,
  delays = [500, 1500],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) => {
  let last;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (error) {
      last = error;

      if (!error || !error.retryable || i === attempts - 1) throw error;

      await sleep(delays[Math.min(i, delays.length - 1)]);
    }
  }

  throw last;
};
