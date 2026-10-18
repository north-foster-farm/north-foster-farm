// Maintenance mode: the switch that stops customers from changing
// anything while the farm fixes the site (#267). It replaces the
// rollback: a release is fixed forward, and this holds the door shut
// meanwhile.
//
// The setting is one document in the jobs store (`setting/maintenance`),
// read on each request, so a flip needs no rebuild and each deploy
// context has its own (the stores are context-prefixed).
//
//   { on, at, by, epoch }   epoch numbers the signed links; rotating it
//                           kills every link handed out before.
//
// What it blocks, by the handlers that call `gate`: placing an order
// (and starting a Venmo one), the whole account area, sign-in and
// sign-up, farm-news sign-ups. What keeps running: the Square, PayPal
// and Resend webhooks, a Venmo capture the customer already approved,
// the scheduled jobs, unsubscribe links, sign-out, the read-only stock
// and payment-config answers, health, and the CLI.
//
// The flip from a phone is a pair of signed links (`links`): opening
// one shows a confirm page, and its button POSTs the flip, so a link
// preview never flips anything. The signature is an HMAC of the action
// and the epoch under MAINTENANCE_SECRET, which is the whole of the
// authentication: whoever holds the link can flip.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookieFrom, sessionKey } from "./auth.mjs";
import { bothEmails, sendMail } from "./mail.mjs";
import { json } from "./http.mjs";
import { log } from "./log.mjs";
import { siteUrl, mailLinks } from "./site.mjs";
import { maintenanceFlipped } from "./templates.mjs";

// The farm's words, exactly (James, #267). No phone, text or email.
export const MESSAGE = "Our site is currently under maintenance. Online " +
  "ordering and account access are temporarily unavailable, but we'll " +
  "be up and running again soon. We apologize for the inconvenience.";

export const ACTIONS = ["on", "off"];

const KEY = "setting/maintenance";

const OFF = { on: false, at: null, by: null, epoch: 0 };

// -> { on, at, by, epoch, unreadable }. A store that cannot be read
// leaves the site open: the same store holds the orders, so a failure
// here is the same failure everywhere, and shutting the door on top of
// it would only hide it.
export const readState = async (stores) => {
  try {
    const record = await stores.jobs.get(KEY);

    return record
      ? {
        on: record.on === true,
        at: record.at || null,
        by: record.by || null,
        epoch: Number.isInteger(record.epoch) ? record.epoch : 0,
        unreadable: false,
      }
      : { ...OFF, unreadable: false };
  } catch (error) {
    log.warn({ event: "maintenance.unreadable", error: String(error) });

    return { ...OFF, unreadable: true };
  }
};

// The answer to an API call that would change something.
export const refusal = () => json(503, {
  maintenance: true,
  message: MESSAGE,
  error: MESSAGE,
}, { "Retry-After": "300" });

const escapeHtml = (text) => String(text).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const PAGE_STYLE = "font-family:system-ui,sans-serif;max-width:32rem;" +
  "margin:3rem auto;padding:0 1rem;font-size:1.125rem;line-height:1.5";

// A page for a link someone clicked (a sign-in or sign-up email).
export const page = (title, body, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex">` +
  `<title>${escapeHtml(title)}</title></head>` +
  `<body style="${PAGE_STYLE}"><h1 style="font-size:1.5rem">${
    escapeHtml(title)}</h1>${body}</body></html>`,
  {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(status === 503 ? { "Retry-After": "300" } : {}),
    },
  }
);

export const refusalPage = () => page(
  "Under maintenance", `<p>${escapeHtml(MESSAGE)}</p>`, 503
);

export const isAdminAddress = (email, env = process.env) =>
  typeof email === "string" && !!email
  && bothEmails(env).some((a) => a.toLowerCase() === email.toLowerCase());

// A signed-in admin (an ADMIN_EMAILS or DEV_NOTIFICATIONS_EMAIL
// address) goes through while customers are refused, so a real test
// order can prove a new token before the switch goes off. It is the
// session that counts: no URL parameter or header can stand in. The
// session is read as it is, without making a customer record.
// -> the admin's address, or null.
export const adminOf = async (stores, req, {
  env = process.env, now = new Date(),
} = {}) => {
  const id = req ? cookieFrom(req) : null;

  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;

  const session = await stores.auth.get(sessionKey(id));

  if (!session || now.getTime() > session.expires) return null;

  return isAdminAddress(session.email, env) ? session.email : null;
};

// -> a Response to return, or null when the request may go on. `req`
// (with `env`, `now` and an `area` for the log) lets an admin through;
// each pass is logged, with a hash for the admin, not the address.
export const gate = async (stores, {
  html = false, req = null, env = process.env, now = new Date(), area = "",
} = {}) => {
  const state = await readState(stores);

  if (!state.on) return null;

  const admin = await adminOf(stores, req, { env, now });

  if (admin) {
    log.warn({
      event: "maintenance.admin_pass", area,
      admin: createHash("sha256").update(admin).digest("hex").slice(0, 8),
    });

    return null;
  }

  return html ? refusalPage() : refusal();
};

// Signed links

const sign = (secret, action, epoch) =>
  createHmac("sha256", secret).update(`maintenance:${action}:${epoch}`)
    .digest("hex");

export const validSignature = (secret, action, epoch, given) => {
  if (!secret || !ACTIONS.includes(action) || typeof given !== "string") {
    return false;
  }

  const want = Buffer.from(sign(secret, action, epoch));
  const have = Buffer.from(given);

  return want.length === have.length && timingSafeEqual(want, have);
};

// -> { on, off } URLs for the current epoch, or null without a secret.
export const links = (env, epoch) => {
  const secret = env.MAINTENANCE_SECRET;

  if (!secret) return null;

  const url = (action) => `${siteUrl(env)}/api/maintenance/${action}` +
    `?sig=${sign(secret, action, epoch)}`;

  return { on: url("on"), off: url("off") };
};

// Flipping

// Sets the switch and tells the farm. A flip to the state it is
// already in changes nothing and says nothing. -> { changed, state }.
export const setState = async (stores, on, {
  by = "unknown", env = process.env, mail = sendMail, now = new Date(),
} = {}) => {
  const before = await readState(stores);

  if (before.on === on) return { changed: false, state: before };

  const state = { on, at: now.toISOString(), by, epoch: before.epoch };

  await stores.jobs.set(KEY, state);
  log.warn({
    event: "maintenance.flipped", on, by,
    context: env.SITE_CONTEXT || env.CONTEXT || null,
  });

  const to = bothEmails(env);

  if (to.length) {
    try {
      await mail({
        to,
        idempotencyKey: `maintenance-${on ? "on" : "off"}-${now.getTime()}`,
        ...maintenanceFlipped(on, {
          by, at: now, links: mailLinks(env),
          context: env.SITE_CONTEXT || env.CONTEXT || "",
        }),
      }, { env, stores });
    } catch (error) {
      log.error({ event: "maintenance.mail_failed", error: String(error) });
    }
  }

  return { changed: true, state: { ...state, unreadable: false } };
};

// Kills every link handed out so far. The next `links` call is new.
export const rotate = async (stores, { now = new Date() } = {}) => {
  const before = await readState(stores);
  const state = {
    on: before.on, at: before.at, by: before.by,
    epoch: before.epoch + 1, rotatedAt: now.toISOString(),
  };

  await stores.jobs.set(KEY, state);
  log.info({ event: "maintenance.rotated", epoch: state.epoch });

  return state;
};
