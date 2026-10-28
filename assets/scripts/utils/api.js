// JSON calls to the site's own functions. Every request carries the
// session cookie; a POST says where it came from, which the functions
// check. `keepalive` lets a request outlive the page that sent it.
// Under maintenance the site answers a change with 503 and the farm's
// message, which goes on the page whatever asked.

import { announce } from "./maintenance.js";

// A request gives up after this long and rejects as a lost connection
// does. Netlify ends any function at 30 s, so no answer comes later:
// only a stalled connection is cut (#507, staging run 40638741710).
export const API_TIMEOUT_MS = 35_000;

export const api = async (path, {
  method = "GET", body, keepalive = false, timeoutMs = API_TIMEOUT_MS,
} = {}) => {
  const res = await fetch(path, {
    method,
    keepalive,
    // Safari before 16 has no AbortSignal.timeout; it goes unbounded.
    signal: typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs) : undefined,
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));

  if (res.status === 503 && data && data.maintenance) announce(data.message);

  return { ok: res.ok, status: res.status, data };
};
