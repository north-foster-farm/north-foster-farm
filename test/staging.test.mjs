import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OUTBOX_KEEP, OUTBOX_PREFIX, sendMail,
} from "../netlify/functions/lib/mail.mjs";
import { library } from "../netlify/functions/lib/library.mjs";
import {
  clear, diffLines, joined, pending, standing, tokenize, versionOf,
} from "../netlify/functions/lib/review.mjs";
import { mailLinks } from "../netlify/functions/lib/site.mjs";
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
    assert.equal(storeName("auth", { SITE_CONTEXT: "branch-deploy" }),
      "branch-deploy-auth", "the runtime variable");
    assert.equal(storeName("auth", {
      SITE_CONTEXT: "production", CONTEXT: "deploy-preview",
    }), "auth", "SITE_CONTEXT wins");
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
    assert.equal(saved.replyTo, null);
  });

  it("keeps a message's own reply-to, so staging can show it", async () => {
    const stores = testStores();

    await sendMail({ ...message, replyTo: "pat@example.com" }, {
      env: { MAIL_DRIVER: "outbox" }, stores,
    });

    const [{ key }] = await stores.jobs.list(OUTBOX_PREFIX);

    assert.equal((await stores.jobs.get(key)).replyTo, "pat@example.com");
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
    assert.equal(staging({ SITE_CONTEXT: "deploy-preview" }), true);
    assert.equal(staging({ SITE_CONTEXT: "production" }), false);

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

describe("the email library", () => {
  const env = { CONTEXT: "branch-deploy", SITE_URL: "https://staging.test" };

  it("is a 404 in production, like every staging path", async () => {
    for (const path of ["/api/staging/emails",
      "/api/staging/emails/sign-in-link"]) {
      const res = await handle(req(path), {
        stores: testStores(), env: { CONTEXT: "production" },
      });

      assert.equal(res.status, 404);
    }
  });

  it("lists every email, built, tagged and marked for approval",
    async () => {
      const res = await handle(req("/api/staging/emails"), {
        stores: testStores(), env,
      });
      const { emails } = await res.json();

      assert.equal(res.status, 200);
      assert.equal(emails.length, library.length);
      assert.equal(new Set(emails.map((e) => e.id)).size, emails.length);
      for (const e of emails) {
        assert.equal(e.error, undefined, e.id);
        assert.ok(e.subject && e.text, e.id);
        assert.ok(e.tags.length, e.id);
        assert.ok(["customer", "farm", "list"].includes(e.audience), e.id);
        assert.ok(["approved", "to approve"].includes(e.approval), e.id);
      }
    });

  it("shows one as HTML or text, with links to the deploy", async () => {
    const stores = testStores();
    const html = await handle(req("/api/staging/emails/sign-in-link"),
      { stores, env });
    const text = await handle(
      req("/api/staging/emails/sign-in-link?format=text"), { stores, env });
    const none = await handle(req("/api/staging/emails/nope"),
      { stores, env });

    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    assert.match(await html.text(), /https:\/\/staging\.test\/account\//);
    assert.match(await text.text(), /^Subject: Your secure sign-in link/);
    assert.equal(none.status, 404);
    assert.deepEqual(await stores.jobs.list(OUTBOX_PREFIX), [],
      "nothing reaches the outbox");
  });
});

describe("James's review in the library", () => {
  const env = { CONTEXT: "branch-deploy", SITE_URL: "https://staging.test" };
  const ID = "address-denied";
  const call = async (stores, path, method = "GET", body) => {
    const res = await handle(req(path, method, body), { stores, env });

    return { status: res.status, data: await res.json() };
  };
  const one = async (stores, id = ID) => (await call(
    stores, "/api/staging/emails"
  )).data.emails.find((e) => e.id === id);

  it("splits every email into text and sample tokens, losing nothing",
    () => {
      const links = mailLinks({ SITE_URL: "https://staging.test" });

      for (const e of library) {
        const m = e.build(links);

        for (const s of [m.subject, m.text]) {
          assert.equal(joined(tokenize(s)), s, e.id);
        }
      }

      const parts = tokenize("New order NFF-2610-K3WM — $94, for Dana " +
        "Whitcomb on Thursday, October 8, 9 – 11 AM.");
      const tokens = parts.filter((p) => p.token).map((p) => p.token);

      assert.deepEqual(tokens, ["NFF-2610-K3WM", "$94", "Dana Whitcomb",
        "Thursday, October 8", "9 – 11 AM"]);
    });

  it("approves an email for its version, and withdraws it", async () => {
    const stores = testStores();
    const before = await one(stores);

    assert.equal(before.approval, "to approve");
    assert.match(before.version, /^[0-9a-f]{12}$/);

    const path = `/api/staging/emails/${ID}/approval`;
    const stale = await call(stores, path, "PUT", { version: "0123" });

    assert.equal(stale.status, 409);

    const ok = await call(stores, path, "PUT", { version: before.version });

    assert.equal(ok.status, 200);
    assert.equal(ok.data.email.approval, "approved");
    assert.equal(ok.data.email.approvedBy, "staging");
    assert.equal((await one(stores)).approval, "approved");

    const back = await call(stores, path, "DELETE");

    assert.equal(back.data.email.approval, "to approve");
    assert.deepEqual(await stores.jobs.list(OUTBOX_PREFIX), [],
      "nothing reaches the outbox");
  });

  it("does not count an approval of another version", () => {
    const e = { approval: "to approve" };
    const now = versionOf({ subject: "Hi", text: "Now." });
    const saved = { approval: { version: "old", at: "x" } };

    assert.equal(standing(e, now, saved).approval, "to approve");
    assert.equal(standing(e, now, {
      approval: { version: now, at: "x" },
    }).approval, "approved");
    assert.equal(standing(e, now, {
      rewrite: { version: "old", subject: [], text: [] },
    }).approval, "to approve", "a rewrite that has landed is done");
  });

  it("refuses to approve what the code already approves", async () => {
    const stores = testStores();
    const e = await one(stores, "sign-in-link");
    const res = await call(stores, "/api/staging/emails/sign-in-link/" +
      "approval", "PUT", { version: e.version });

    assert.equal(res.status, 409);
  });

  it("saves a rewrite with its tokens, and reverts it", async () => {
    const stores = testStores();
    const e = await one(stores);
    const path = `/api/staging/emails/${ID}/rewrite`;

    await call(stores, `/api/staging/emails/${ID}/approval`, "PUT",
      { version: e.version });

    const text = [{ text: "Hi " }, { token: "Dana" },
      { text: ", we can't reach you yet." }];
    const res = await call(stores, path, "PUT", {
      version: e.version, subject: [{ text: "Not yet" }], text,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.email.approval, "rewritten",
      "a rewrite replaces the approval");
    assert.deepEqual(res.data.email.rewrite.text, text);
    assert.equal((await one(stores)).approval, "rewritten");

    const back = await call(stores, path, "DELETE");

    assert.equal(back.data.email.approval, "to approve");
  });

  it("refuses a rewrite with a token the email lacks, or no subject",
    async () => {
      const stores = testStores();
      const { version } = await one(stores);
      const path = `/api/staging/emails/${ID}/rewrite`;
      const bad = [
        { subject: [{ text: "Hi" }], text: [{ token: "Mallory" }] },
        { subject: [{ text: " " }], text: [{ text: "Hi" }] },
        { subject: [{ text: "Two\nlines" }], text: [{ text: "Hi" }] },
        { subject: [{ text: "Hi" }], text: "Hi" },
        { subject: [{ text: "Hi" }], text: [{ html: "<b>" }] },
      ];

      for (const body of bad) {
        const res = await call(stores, path, "PUT", { version, ...body });

        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal((await one(stores)).approval, "to approve");
    });

  it("gives the same version on every deploy, whatever its links",
    async () => {
      const a = await handle(req("/api/staging/emails"), {
        stores: testStores(), env,
      });
      const b = await handle(req("/api/staging/emails"), {
        stores: testStores(),
        env: { CONTEXT: "deploy-preview", SITE_URL: "https://other.test" },
      });
      const versions = async (res) => (await res.json()).emails
        .map((e) => e.version);

      assert.deepEqual(await versions(a), await versions(b));
    });

  it("lists what waits to be ported, with a diff, and clears it",
    async () => {
      const stores = testStores();
      const links = mailLinks(env);
      const e = await one(stores);
      const other = await one(stores, "pick-new-time-reply");

      await call(stores, `/api/staging/emails/${ID}/rewrite`, "PUT", {
        version: e.version, subject: e.parts.subject,
        text: [{ text: "Sorry, " }, { token: "Dana" }, { text: "." }],
      });
      await call(stores, "/api/staging/emails/pick-new-time-reply/" +
        "approval", "PUT", { version: other.version });
      await stores.jobs.set("library/approval/farm-alert",
        { version: "old", at: "x" });

      const items = await pending(stores, library, links);
      const by = Object.fromEntries(items.map((r) => [r.id, r]));

      assert.equal(items.length, 3);
      assert.equal(by[ID].state, "port");
      assert.ok(by[ID].diff.includes("+ Sorry, ⟦Dana⟧."));
      assert.ok(by[ID].diff.includes("  Subject: We can't deliver to your " +
        "address"));
      assert.ok(by[ID].diff.includes("- Hi ⟦Dana⟧,"));
      assert.equal(by["pick-new-time-reply"].kind, "approval");
      assert.equal(by["pick-new-time-reply"].state, "port");
      assert.equal(by["farm-alert"].state, "stale");

      await clear(stores, ID);
      assert.equal((await pending(stores, library, links)).length, 2);
    });

  it("diffs lines", () => {
    assert.deepEqual(diffLines("a\nb\nc", "a\nx\nc"),
      ["  a", "+ x", "- b", "  c"]);
  });

  it("is a 404 in production", async () => {
    for (const kind of ["approval", "rewrite"]) {
      const res = await handle(req(`/api/staging/emails/${ID}/${kind}`,
        "PUT", { version: "x" }), {
        stores: testStores(), env: { CONTEXT: "production" },
      });

      assert.equal(res.status, 404);
    }
  });
});
