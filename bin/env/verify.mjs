// `bin/nff env verify --staging|--production`: after `env push` and
// the deploy, one harmless read-only call per service, to prove that
// each credential in the env file is right. Netlify never returns a
// secret, so this is the only check of a value. Output is names and
// pass/fail only: a service's answer is never printed, and neither is
// a value (every message is scrubbed of the file's values).
//
// Square          GET the location: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID
// PayPal          a client-credentials token, then GET the webhook:
//                 PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID
// Resend          production only: list the domains (a sending-only key
//                 is refused for that, and counts as working), read the
//                 audience's contacts: RESEND_API_KEY, RESEND_AUDIENCE_KEY
// Axiom           an ingest of nothing: AXIOM_TOKEN, AXIOM_DATASET
// Healthchecks    the URL's shape only. A ping is recorded as a success,
//                 so none is sent
// R2              list one object, signed: BACKUP_R2_ACCESS_KEY_ID,
//                 BACKUP_R2_SECRET_ACCESS_KEY (production only)
//
// A key with no call (a signing secret, a public id) is listed as not
// checked, so a pass is never read as more than it is.

import { createHash } from "node:crypto";

import { sign } from "../../netlify/functions/lib/backup.mjs";
import { resendAllowed } from "../../netlify/functions/lib/resend-guard.mjs";
import { redact } from "./netlify.mjs";

const SQUARE_HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
};
const PAYPAL_HOSTS = {
  live: "https://api-m.paypal.com",
  sandbox: "https://api-m.sandbox.paypal.com",
};
const HEALTHCHECKS = /^https:\/\/hc-ping\.com\/[0-9a-f-]{36}(\/[a-z]+)?$/;
const TIMEOUT = 15_000;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// -> { ok, note }: ok true/false, note a short fixed phrase.
const status = (res, extra = {}) => ({
  ok: res.ok, note: res.ok ? "" : `HTTP ${res.status}`, ...extra,
});

const call = async (fetchImpl, url, options = {}) => {
  try {
    return await fetchImpl(url, {
      ...options, signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (error) {
    return { ok: false, status: 0, failure: error.name || "error" };
  }
};

const result = (res) => (res.failure
  ? { ok: false, note: `no answer (${res.failure})` } : status(res));

const square = async (v, fetchImpl) => {
  const production = v.SQUARE_ENV === "production";
  const res = await call(fetchImpl,
    `${SQUARE_HOSTS[production ? "production" : "sandbox"]}/v2/locations/${
      encodeURIComponent(v.SQUARE_LOCATION_ID || "")}`, {
      headers: {
        Authorization: `Bearer ${v.SQUARE_ACCESS_TOKEN}`,
        "Square-Version": v.SQUARE_VERSION || "2026-09-16",
      },
    });
  const r = result(res);

  // 401 is the token; 404 is the location, under a token that works.
  if (res.status === 404) {
    return [
      ["SQUARE_ACCESS_TOKEN", { ok: true, note: "" }],
      ["SQUARE_LOCATION_ID", r],
    ];
  }

  return [["SQUARE_ACCESS_TOKEN", r],
    ["SQUARE_LOCATION_ID", r.ok ? r : { ok: null, note: "needs the token" }]];
};

const paypal = async (v, fetchImpl) => {
  const host = PAYPAL_HOSTS[v.PAYPAL_ENV === "live" ? "live" : "sandbox"];
  const basic = Buffer.from(
    `${v.PAYPAL_CLIENT_ID}:${v.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const login = await call(fetchImpl, `${host}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const r = result(login);
  const pair = [["PAYPAL_CLIENT_ID", r], ["PAYPAL_CLIENT_SECRET", r]];

  if (!r.ok) {
    return [...pair, ["PAYPAL_WEBHOOK_ID", { ok: null, note: "needs login" }]];
  }

  const { "access_token": token } = await login.json().catch(() => ({}));
  const hook = await call(fetchImpl, `${host}/v1/notifications/webhooks/${
    encodeURIComponent(v.PAYPAL_WEBHOOK_ID || "")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return [...pair, ["PAYPAL_WEBHOOK_ID", result(hook)]];
};

const resend = async (v, fetchImpl) => {
  const out = [];

  if (v.RESEND_API_KEY) {
    const res = await call(fetchImpl, "https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${v.RESEND_API_KEY}` },
    });
    const body = res.ok || res.failure ? {}
      : await res.json().catch(() => ({}));
    // A sending-only key is refused for this call, and is a working key.
    const sendingOnly = res.status === 401
      && body.name === "restricted_api_key";

    out.push(["RESEND_API_KEY", sendingOnly
      ? { ok: true, note: "sending-only key" } : result(res)]);
  }
  if (v.RESEND_AUDIENCE_KEY) {
    const res = await call(fetchImpl, `https://api.resend.com/audiences/${
      encodeURIComponent(v.RESEND_AUDIENCE_ID || "")}/contacts`, {
      headers: { Authorization: `Bearer ${v.RESEND_AUDIENCE_KEY}` },
    });

    out.push(["RESEND_AUDIENCE_KEY", result(res)]);
  }

  return out;
};

const axiom = async (v, fetchImpl) => {
  const res = await call(fetchImpl, `https://api.axiom.co/v1/datasets/${
    encodeURIComponent(v.AXIOM_DATASET || "")}/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${v.AXIOM_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "[]",
  });
  const r = result(res);

  return [["AXIOM_TOKEN", r], ["AXIOM_DATASET", r]];
};

const healthchecks = async (v) => [
  "HEALTHCHECKS_JOBS_URL", "HEALTHCHECKS_ALERT_URL", "HEALTHCHECKS_BACKUP_URL",
].filter((name) => name in v).map((name) => [name, HEALTHCHECKS.test(v[name])
  ? { ok: true, note: "shape only, not pinged" }
  : { ok: false, note: "not a hc-ping.com URL" }]);

const r2 = async (v, fetchImpl) => {
  const url = `${String(v.BACKUP_R2_ENDPOINT).replace(/\/$/, "")}/${
    v.BACKUP_R2_BUCKET}?list-type=2&max-keys=1`;
  const headers = sign({
    method: "GET", url, payloadHash: sha256(""),
    accessKeyId: v.BACKUP_R2_ACCESS_KEY_ID,
    secretAccessKey: v.BACKUP_R2_SECRET_ACCESS_KEY,
  });
  const r = result(await call(fetchImpl, url, { headers }));

  return [["BACKUP_R2_ACCESS_KEY_ID", r], ["BACKUP_R2_SECRET_ACCESS_KEY", r]];
};

// Keys with no harmless call, named so they aren't mistaken for passes.
const UNCHECKED = [
  "SQUARE_WEBHOOK_SIGNATURE_KEY", "RESEND_WEBHOOK_SECRET",
  "MAINTENANCE_SECRET", "STAGING_TOKEN", "GATE_RESEND_KEY",
  "E2E_STAGING_TOKEN",
  "BACKUP_AGE_RECIPIENT",
];

// The env file's values, a Map of name to value. -> { lines, failed,
// unchecked }: each line reads "Service: NAME ok|FAILED (note)", names
// only.
export const verifyEnv = async (env, values, { fetchImpl = fetch } = {}) => {
  const v = Object.fromEntries(values);
  const services = [
    ["Square", "SQUARE_ACCESS_TOKEN", square],
    ["PayPal", "PAYPAL_CLIENT_ID", paypal],
    ["Resend", resendAllowed({ SITE_CONTEXT: env }) && "RESEND_API_KEY",
      resend],
    ["Axiom", "AXIOM_TOKEN", axiom],
    ["Healthchecks", "HEALTHCHECKS_JOBS_URL", healthchecks],
    ["R2", env === "production" && "BACKUP_R2_ACCESS_KEY_ID", r2],
  ];
  const secrets = [...values.values()];
  const lines = [];
  let failed = 0;

  for (const [service, gate, run] of services) {
    if (!gate || !v[gate]) {
      lines.push(`${service}: skipped (${gate ? `${gate} not set`
        : "production only"})`);
      continue;
    }

    let checks;

    try {
      checks = await run(v, fetchImpl);
    } catch (error) {
      checks = [[gate, { ok: false,
        note: redact(error.message, secrets).slice(0, 80) }]];
    }
    for (const [name, c] of checks) {
      if (c.ok === false) failed += 1;
      lines.push(`${service}: ${name} ${c.ok === null ? "not tried"
        : c.ok ? "ok" : "FAILED"}${c.note ? ` (${c.note})` : ""}`);
    }
  }

  return {
    lines, failed,
    unchecked: UNCHECKED.filter((name) => name in v),
  };
};
