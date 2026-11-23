// One heartbeat to a healthchecks.io URL (#925, phase 3). Moved out of
// lib/health.mjs, which re-exports both names, so lib/breaker.mjs can
// page the phone without importing health.mjs and all it imports. It
// imports nothing from lib/ but log.mjs.

import { log } from "./log.mjs";

export const PING_TIMEOUT = 3000;

// One heartbeat. `ok` false posts the report to /fail. Never throws.
export const ping = async (url, {
  ok = true, body = null, fetchImpl = globalThis.fetch,
} = {}) => {
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT);

  try {
    const res = await fetchImpl(ok ? url : `${url.replace(/\/$/, "")}/fail`, {
      method: ok && !body ? "GET" : "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body).slice(0, 10_000) : undefined,
      signal: controller.signal,
    });

    return res.ok;
  } catch (error) {
    log.warn({ event: "health.ping_failed", error: String(error) });

    return false;
  } finally {
    clearTimeout(timer);
  }
};
