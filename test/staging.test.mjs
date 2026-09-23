import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OUTBOX_KEEP, OUTBOX_PREFIX, sendMail,
} from "../netlify/functions/lib/mail.mjs";
import { storeName, testStores } from "../netlify/functions/lib/store.mjs";
import { handle, staging } from "../netlify/functions/staging.mjs";

const message = {
  to: "pat@example.com", subject: "Sign in to North Foster Farm",
  text: "Click the link.",
  html: "<html><body><p>Click the link.</p></body></html>",
};

const req = (path, method = "GET", body, headers = {}) =>
  new Request(`https://x${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("stores by context", () => {
  it("keeps the bare names for production and for no context", () => {
    assert.equal(storeName("orders", {}), "orders");
    assert.equal(storeName("orders", { CONTEXT: "production" }), "orders");
  });

  it("prefixes every other context", () => {
    assert.equal(storeName("orders", { CONTEXT: "deploy-preview" }),
      "deploy-preview-orders");
    assert.equal(storeName("jobs", { CONTEXT: "branch-deploy" }),
      "branch-deploy-jobs");
    assert.equal(storeName("auth", { CONTEXT: "dev" }), "dev-auth");
  });
});

describe("the outbox driver", () => {
  it("writes the message to the jobs store and sends nothing", async () => {
    const stores = testStores();
    const calls = [];
    const fetchImpl = async () => { calls.push(1); };
    const out = await sendMail(message, {
      env: { MAIL_DRIVER: "outbox" }, fetchImpl, stores,
    });
    const keys = await stores.jobs.list(OUTBOX_PREFIX);
    const saved = await stores.jobs.get(keys[0].key);

    assert.equal(out.driver, "outbox");
    assert.equal(calls.length, 0);
    assert.equal(keys.length, 1);
    assert.equal(saved.id, out.id);
    assert.equal(saved.subject, message.subject);
    assert.equal(saved.html, message.html);
    assert.equal(saved.to, message.to);
  });

  it("keeps only the last OUTBOX_KEEP", async () => {
    const stores = testStores();

    for (let i = 0; i < OUTBOX_KEEP + 3; i += 1) {
      await stores.jobs.set(`${OUTBOX_PREFIX}2026-01-01T00-00-${String(i)
        .padStart(4, "0")}`, { id: String(i) });
    }
    await sendMail(message, { env: { MAIL_DRIVER: "outbox" }, stores });

    assert.equal((await stores.jobs.list(OUTBOX_PREFIX)).length, OUTBOX_KEEP);
  });
});

describe("the staging endpoints", () => {
  const env = { CONTEXT: "deploy-preview", MAIL_DRIVER: "outbox" };

  it("answer only off production", async () => {
    assert.equal(staging({}), false);
    assert.equal(staging({ CONTEXT: "production" }), false);
    assert.equal(staging({ CONTEXT: "branch-deploy" }), true);

    for (const e of [{}, { CONTEXT: "production" }]) {
      const res = await handle(req("/api/staging/info"), {
        stores: testStores(), env: e,
      });

      assert.equal(res.status, 404);
    }
  });

  it("require the token when one is set, as a bearer or a query", async () => {
    const stores = testStores();
    const e = { ...env, STAGING_TOKEN: "s3cret" };

    assert.equal((await handle(req("/api/staging/info"), { stores, env: e }))
      .status, 401);
    assert.equal((await handle(req("/api/staging/info", "GET", undefined,
      { Authorization: "Bearer s3cret" }), { stores, env: e })).status, 200);
    assert.equal((await handle(req("/api/staging/info?token=s3cret"),
      { stores, env: e })).status, 200);
  });

  it("describe the deploy", async () => {
    const res = await handle(req("/api/staging/info"), {
      stores: testStores(), env: { ...env, SQUARE_ENV: "sandbox" },
    });

    assert.deepEqual(await res.json(), {
      context: "deploy-preview", mailDriver: "outbox", squareEnv: "sandbox",
      siteUrl: null,
    });
  });

  it("list, show and clear the outbox", async () => {
    const stores = testStores();

    await sendMail(message, { env, stores });
    await sendMail({ ...message, subject: "Second" }, { env, stores });

    const list = await (await handle(req("/api/staging/outbox"),
      { stores, env })).json();

    assert.equal(list.messages.length, 2);
    assert.equal(list.messages[0].subject, "Second", "newest first");
    assert.equal(list.messages[1].to, "pat@example.com");
    assert.equal(list.messages[0].html, undefined, "the list is light");

    const id = list.messages[1].id;
    const html = await handle(req(`/api/staging/outbox/${id}`),
      { stores, env });
    const body = await html.text();

    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    assert.match(html.headers.get("content-security-policy"),
      /style-src 'unsafe-inline'/);
    assert.match(body, /<body><div[^>]*><strong>Sign in to North Foster Farm/);
    assert.match(body, /<p>Click the link.<\/p>/);

    const text = await handle(req(`/api/staging/outbox/${id}?format=text`),
      { stores, env });

    assert.match(await text.text(),
      /^To: pat@example.com\nSubject: Sign in to North Foster Farm\n\nClick/);
    assert.equal((await handle(req("/api/staging/outbox/nope"),
      { stores, env })).status, 404);

    const cleared = await handle(req("/api/staging/outbox", "DELETE"),
      { stores, env });

    assert.equal((await cleared.json()).removed, 2);
    assert.equal((await stores.jobs.list(OUTBOX_PREFIX)).length, 0);
  });

  it("run the jobs now or as of a time, and can reopen the day's reports",
    async () => {
      const stores = testStores();
      const runs = [];
      const run = async (s, opts) => {
        runs.push(opts.now.toISOString());

        return { at: opts.now.toISOString(), paid: [] };
      };
      const now = new Date("2026-10-05T14:00:00Z");

      await stores.jobs.set("report/morning/2026-10-05", { at: "x" });
      await stores.jobs.set("report/tomorrow/2026-10-05", { at: "x" });

      const plain = await handle(req("/api/staging/jobs/run", "POST", {}),
        { stores, env, now, run });

      assert.equal(plain.status, 200);
      assert.equal((await plain.json()).at, "2026-10-05T14:00:00.000Z");
      assert.ok(await stores.jobs.get("report/morning/2026-10-05"),
        "no reset asked for");

      const asOf = await handle(req("/api/staging/jobs/run", "POST", {
        at: "2026-10-05T22:30:00Z", reset: true,
      }), { stores, env, now, run });

      assert.equal(asOf.status, 200);
      assert.deepEqual(runs,
        ["2026-10-05T14:00:00.000Z", "2026-10-05T22:30:00.000Z"]);
      assert.equal(await stores.jobs.get("report/morning/2026-10-05"), null);
      assert.equal(await stores.jobs.get("report/tomorrow/2026-10-05"), null);

      const bad = await handle(req("/api/staging/jobs/run", "POST",
        { at: "yesterday" }), { stores, env, now, run });

      assert.equal(bad.status, 400);
    });
});
