import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyEnv } from "../bin/env/verify.mjs";

const SECRETS = {
  SQUARE_ENV: "sandbox",
  SQUARE_ACCESS_TOKEN: "sq-secret-token-1111",
  SQUARE_LOCATION_ID: "LOC1",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "sq-sig-secret-2222",
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "pp-client-3333",
  PAYPAL_CLIENT_SECRET: "pp-secret-4444",
  PAYPAL_WEBHOOK_ID: "WH1",
  RESEND_API_KEY: "re_send_secret_5555",
  RESEND_AUDIENCE_ID: "aud1",
  RESEND_AUDIENCE_KEY: "re_aud_secret_6666",
  AXIOM_TOKEN: "xaat-secret-7777",
  AXIOM_DATASET: "nff-site",
  HEALTHCHECKS_JOBS_URL:
    "https://hc-ping.com/12345678-1234-1234-1234-123456789abc",
  HEALTHCHECKS_ALERT_URL: "https://example.com/not-a-ping",
  BACKUP_R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  BACKUP_R2_BUCKET: "nff-backups",
  BACKUP_R2_ACCESS_KEY_ID: "r2-key-id-8888",
  BACKUP_R2_SECRET_ACCESS_KEY: "r2-secret-9999",
};

const values = (over = {}) => new Map(Object.entries({ ...SECRETS, ...over }));

// A fake network: `answers` maps a URL fragment to a status and body.
const network = (answers = {}) => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url: String(url), options });

    const key = Object.keys(answers).find((k) => String(url).includes(k));
    const [status, body] = key ? answers[key] : [200, {}];

    return new Response(JSON.stringify(body), { status });
  };

  return { fetchImpl, seen };
};

const allSecrets = Object.values(SECRETS);
const text = (r) => [...r.lines, ...r.unchecked].join("\n");

describe("env verify", () => {
  const login = { "oauth2/token": [200, { "access_token": "T" }] };

  it("passes every service by name", async () => {
    const r = await verifyEnv("production", values({
      HEALTHCHECKS_ALERT_URL: SECRETS.HEALTHCHECKS_JOBS_URL,
    }), network(login));

    assert.equal(r.failed, 0);
    assert.deepEqual(r.lines, [
      "Square: SQUARE_ACCESS_TOKEN ok",
      "Square: SQUARE_LOCATION_ID ok",
      "PayPal: PAYPAL_CLIENT_ID ok",
      "PayPal: PAYPAL_CLIENT_SECRET ok",
      "PayPal: PAYPAL_WEBHOOK_ID ok",
      "Resend: RESEND_API_KEY ok",
      "Resend: RESEND_AUDIENCE_KEY ok",
      "Axiom: AXIOM_TOKEN ok",
      "Axiom: AXIOM_DATASET ok",
      "Healthchecks: HEALTHCHECKS_JOBS_URL ok (shape only, not pinged)",
      "Healthchecks: HEALTHCHECKS_ALERT_URL ok (shape only, not pinged)",
      "R2: BACKUP_R2_ACCESS_KEY_ID ok",
      "R2: BACKUP_R2_SECRET_ACCESS_KEY ok",
    ]);
    assert.deepEqual(r.unchecked, ["SQUARE_WEBHOOK_SIGNATURE_KEY"]);
  });

  it("names the credential that fails, and prints no value", async () => {
    const r = await verifyEnv("production", values(), network({
      ...login,
      "/v2/locations": [401, { detail: SECRETS.SQUARE_ACCESS_TOKEN }],
      "api.axiom.co": [403, { message: SECRETS.AXIOM_TOKEN }],
    }));

    assert.equal(r.failed, 4);
    assert.ok(r.lines.includes(
      "Square: SQUARE_ACCESS_TOKEN FAILED (HTTP 401)"));
    assert.ok(r.lines.includes("Axiom: AXIOM_TOKEN FAILED (HTTP 403)"));
    assert.ok(r.lines.includes("Healthchecks: HEALTHCHECKS_ALERT_URL FAILED " +
      "(not a hc-ping.com URL)"));
    for (const secret of allSecrets) {
      assert.ok(!text(r).includes(secret), "no value in the report");
    }
  });

  it("counts a Resend sending-only key as working", async () => {
    const r = await verifyEnv("production", values(), network({
      ...login,
      "api.resend.com/domains": [401, { name: "restricted_api_key" }],
    }));

    assert.ok(r.lines.includes(
      "Resend: RESEND_API_KEY ok (sending-only key)"));
  });

  it("separates a wrong location from a wrong token", async () => {
    const r = await verifyEnv("staging", values(), network({
      ...login, "/v2/locations": [404, {}],
    }));

    assert.ok(r.lines.includes("Square: SQUARE_ACCESS_TOKEN ok"));
    assert.ok(r.lines.includes(
      "Square: SQUARE_LOCATION_ID FAILED (HTTP 404)"));
  });

  it("skips what its environment doesn't have", async () => {
    const net = network(login);
    const r = await verifyEnv("staging", values(), net);

    assert.ok(r.lines.includes("Resend: skipped (production only)"));
    assert.ok(r.lines.includes("R2: skipped (production only)"));
    assert.ok(!net.seen.some((c) => /resend|r2\./.test(c.url)));
  });

  it("reports a service that doesn't answer, and goes on", async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes("axiom")) throw new Error(SECRETS.AXIOM_TOKEN);

      return new Response("{}", { status: 200 });
    };
    const r = await verifyEnv("staging", values(), { fetchImpl });

    assert.ok(r.lines.includes(
      "Axiom: AXIOM_TOKEN FAILED (no answer (Error))"));
    assert.ok(r.lines.includes("Square: SQUARE_ACCESS_TOKEN ok"));
    for (const secret of allSecrets) {
      assert.ok(!text(r).includes(secret), "no value in the report");
    }
  });
});
