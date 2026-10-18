// JSON calls to the site's own functions. Every request carries the
// session cookie; a POST says where it came from, which the functions
// check. Under maintenance the site answers a change with 503 and the
// farm's message, which goes on the page whatever asked.

import { announce } from "./maintenance.js";

export const api = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));

  if (res.status === 503 && data && data.maintenance) announce(data.message);

  return { ok: res.ok, status: res.status, data };
};
