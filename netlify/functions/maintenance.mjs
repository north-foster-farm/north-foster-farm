// The maintenance switch (#267), flipped from a phone:
//
//   GET  /api/maintenance            { maintenance, message }, public
//   GET  /api/maintenance/on|off?sig=...   a confirm page with a button
//   POST /api/maintenance/on|off?sig=...   the flip, from that button
//
// The links come from `bin/nff maintenance links`. They are signed
// (lib/maintenance.mjs), the page asks before it acts so a link
// preview flips nothing, and a wrong signature is a plain 404.

import { json } from "./lib/http.mjs";
import { sameSite } from "./lib/auth.mjs";
import { withLog } from "./lib/log.mjs";
import {
  ACTIONS, MESSAGE, page, readState, setState, validSignature,
} from "./lib/maintenance.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

// Per-instance, best effort, like the order handler's: only wrong
// signatures count.
const RATE = { windowMs: 10 * 60_000, max: 10 };
const misses = new Map();

const lockedOut = (ip, now) => !!ip && (misses.get(ip) || [])
  .filter((t) => now - t < RATE.windowMs).length >= RATE.max;

const miss = (ip, now) => {
  if (!ip) return;
  misses.set(ip, [...(misses.get(ip) || [])
    .filter((t) => now - t < RATE.windowMs), now]);
};

const notFound = () => page("Not found", "<p>That link isn't valid.</p>", 404);

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = new Date(),
  ip = "",
  mail,
} = {}) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "GET" && path === "/api/maintenance") {
    const state = await readState(stores);

    return json(200, {
      maintenance: state.on, message: state.on ? MESSAGE : null,
    });
  }

  const m = path.match(/^\/api\/maintenance\/(on|off)$/);

  if (!m || !["GET", "POST"].includes(req.method)) return notFound();
  if (lockedOut(ip, now.getTime())) return notFound();

  const action = m[1];
  const state = await readState(stores);

  if (!ACTIONS.includes(action) || !validSignature(
    env.MAINTENANCE_SECRET, action, state.epoch, url.searchParams.get("sig")
  )) {
    miss(ip, now.getTime());

    return notFound();
  }

  const on = action === "on";
  const label = on ? "Turn maintenance ON" : "Turn maintenance OFF";
  const where = env.SITE_CONTEXT || env.CONTEXT || "";
  const site = where && where !== "production" ? ` (${where})` : "";

  if (req.method === "GET") {
    return page(`Maintenance${site}`,
      `<p>Maintenance is now <strong>${state.on ? "ON" : "OFF"}</strong>.` +
      `</p><form method="post" action="${url.pathname}` +
      `?sig=${encodeURIComponent(url.searchParams.get("sig"))}">` +
      `<button style="font-size:1.25rem;padding:.75rem 1.25rem" ` +
      `type="submit">${label}</button></form>`);
  }
  if (!sameSite(req)) return notFound();

  const result = await setState(stores, on, {
    by: "signed link", env, now, ...(mail ? { mail } : {}),
  });

  return page(`Maintenance${site}`,
    `<p>Maintenance is now <strong>${on ? "ON" : "OFF"}</strong>` +
    `${result.changed ? "" : " (it already was)"}.</p>`);
};

export default withLog("maintenance", async (req, context) =>
  handle(req, { ip: context && context.ip }));

export const config = {
  path: ["/api/maintenance", "/api/maintenance/*"],
};
