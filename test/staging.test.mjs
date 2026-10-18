import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import {
  areaOf, handle, KEYS, staging,
} from "../netlify/functions/staging.mjs";

const message = {
  to: "pat@example.com", subject: "Sign in to North Foster Farm",
  text: "Click the link.",
  html: "<html><body><p>Click the link.</p></body></html>",
};

// Every staging context in these tests holds TOKEN, and every request
// carries it unless a test says otherwise.
const TOKEN = "s3cret";

const req = (path, method = "GET", body, headers = {}) =>
  new Request(`https://x${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
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
  const env = {
    CONTEXT: "deploy-preview", MAIL_DRIVER: "outbox", STAGING_TOKEN: TOKEN,
  };

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

  // Every route, so a new one cannot slip past the gate.
  const routes = [
    ["GET", "/api/staging/info"],
    ["GET", "/api/staging/outbox"],
    ["DELETE", "/api/staging/outbox"],
    ["GET", "/api/staging/outbox/2026-01-01T00-00-0000"],
    ["POST", "/api/staging/jobs/run"],
    ["GET", "/api/staging/emails"],
    ["GET", "/api/staging/emails/sign-in-link"],
    ["GET", "/api/staging/signatures"],
    ["GET", "/api/staging/signatures/james"],
    ["PUT", "/api/staging/emails/sign-in-link/approval"],
    ["DELETE", "/api/staging/emails/sign-in-link/approval"],
    ["PUT", "/api/staging/emails/sign-in-link/rewrite"],
    ["DELETE", "/api/staging/emails/sign-in-link/rewrite"],
    ["POST", "/api/staging/throw"],
    ["GET", "/api/staging/nothing-here"],
  ];
  // Throws by design, once past the gate (the crash alert's proof).
  const THROWS = "/api/staging/throw";
  const run = async () => ({ ran: [] });
  const ask = (method, path, headers) => req(path, method,
    ["POST", "PUT"].includes(method) ? {} : undefined, headers);

  it("fail closed: every route is a 404 with no token set", async () => {
    const open = { CONTEXT: "branch-deploy", MAIL_DRIVER: "outbox" };

    for (const [method, path] of routes) {
      for (const e of [open, { ...open, STAGING_TOKEN: "" }]) {
        const res = await handle(ask(method, path), {
          stores: testStores(), env: e, run,
        });

        assert.equal(res.status, 404, `${method} ${path}`);
      }
    }
  });

  it("refuse every route without the right token", async () => {
    for (const [method, path] of routes) {
      for (const headers of [{ Authorization: "" },
        { Authorization: "Bearer wrong" },
        { Authorization: `Bearer ${TOKEN}x` }]) {
        const res = await handle(ask(method, path, headers), {
          stores: testStores(), env, run,
        });

        assert.equal(res.status, 401, `${method} ${path}`);
      }
    }
  });

  it("let every route through with the right token", async () => {
    for (const [method, path] of routes) {
      const answer = handle(ask(method, path), {
        stores: testStores(), env, run,
      });

      if (path === THROWS) {
        await assert.rejects(answer, /Staging proof/);
        continue;
      }

      const res = await answer;

      assert.notEqual(res.status, 401, `${method} ${path}`);
      assert.notEqual(res.status, 403, `${method} ${path}`);
    }
  });

  it("take the token as a bearer or a query", async () => {
    const stores = testStores();
    const bare = { Authorization: "" };

    assert.equal((await handle(req("/api/staging/info", "GET", undefined,
      bare), { stores, env })).status, 401);
    assert.equal((await handle(req("/api/staging/info", "GET", undefined,
      { Authorization: `Bearer ${TOKEN}` }), { stores, env })).status, 200);
    assert.equal((await handle(req(`/api/staging/info?token=${TOKEN}`,
      "GET", undefined, bare), { stores, env })).status, 200);
  });


  it("describe the deploy", async () => {
    const res = await handle(req("/api/staging/info"), {
      stores: testStores(), env: { ...env, SQUARE_ENV: "sandbox" },
    });

    assert.deepEqual(await res.json(), {
      key: "STAGING_TOKEN", can: KEYS.STAGING_TOKEN,
      context: "deploy-preview", mailDriver: "outbox", squareEnv: "sandbox",
      siteUrl: null,
    });
  });

  describe("the reviewer's key", () => {
    const REVIEWER = "r3viewer";
    const both = { ...env, STAGING_REVIEWER_TOKEN: REVIEWER };
    const as = (token, method, path) => ask(method, path,
      { Authorization: `Bearer ${token}` });
    const open = new Set(["info", "signatures"]);

    it("opens the signatures and the info, and names itself", async () => {
      const info = await handle(as(REVIEWER, "GET", "/api/staging/info"),
        { stores: testStores(), env: both });

      assert.equal(info.status, 200);

      const body = await info.json();

      assert.equal(body.key, "STAGING_REVIEWER_TOKEN");
      assert.deepEqual(body.can, ["info", "signatures"]);

      const sigs = await handle(
        as(REVIEWER, "GET", "/api/staging/signatures"),
        { stores: testStores(), env: both });

      assert.equal(sigs.status, 200);
    });

    it("opens no email library, outbox, jobs run or crash", async () => {
      for (const [method, path] of routes) {
        if (path.startsWith("/api/staging/signatures")
          || path === "/api/staging/info") continue;

        const res = await handle(as(REVIEWER, method, path),
          { stores: testStores(), env: both, run });

        assert.equal(res.status, 403, `${method} ${path}`);
      }
      assert.deepEqual([...open], ["info", "signatures"]);
    });

    it("is denied a path no area owns, which the owner just misses",
      async () => {
        const path = "/api/staging/nothing-here";

        assert.equal(areaOf("GET", path), null);
        assert.equal((await handle(as(REVIEWER, "GET", path),
          { stores: testStores(), env: both })).status, 403);
        assert.equal((await handle(as(TOKEN, "GET", path),
          { stores: testStores(), env: both })).status, 404);
      });

    it("has an area for every route staging.mjs serves", () => {
      const source = readFileSync(new URL(
        "../netlify/functions/staging.mjs", import.meta.url), "utf8");
      const paths = [...new Set(source.match(
        /"\/api\/staging\/[a-z0-9/_-]*"/g))]
        .map((p) => p.slice(1, -1))
        .filter((p) => p !== "/api/staging/e2e");

      assert.ok(paths.length >= 6, paths.join());
      for (const path of paths) {
        const area = areaOf("POST", path.replace(/\/$/, ""));

        assert.ok(area, `${path} has no area in areaOf`);
        assert.ok(Object.values(KEYS).some((can) => can.includes(area)),
          `${area} belongs to no key`);
      }
    });

    it("is refused where only the owner's key is set, and the reverse",
      async () => {
        const res = await handle(as(REVIEWER, "GET", "/api/staging/info"),
          { stores: testStores(), env });

        assert.equal(res.status, 401);

        const only = { CONTEXT: "deploy-preview",
          STAGING_REVIEWER_TOKEN: REVIEWER };

        for (const token of ["", TOKEN]) {
          const denied = await handle(as(token, "GET", "/api/staging/info"),
            { stores: testStores(), env: only });

          assert.equal(denied.status, 401);
        }
        assert.equal((await handle(as(REVIEWER, "GET", "/api/staging/info"),
          { stores: testStores(), env: only })).status, 200);
      });

    it("never opens the end-to-end path", async () => {
      const res = await handle(as(REVIEWER, "POST", "/api/staging/e2e"),
        { stores: testStores(), env: { ...both, E2E_STAGING_TOKEN: "e2e" } });

      assert.equal(res.status, 401);
    });

    it("logs each use by the key's name, never its value", async (t) => {
      const lines = [];

      t.mock.method(console, "info", (text) => lines.push(String(text)));
      await handle(as(REVIEWER, "GET", "/api/staging/info"),
        { stores: testStores(), env: both });
      await handle(as(TOKEN, "GET", "/api/staging/info"),
        { stores: testStores(), env: both });

      const used = lines.filter((l) => l.includes("staging.key_used"));

      assert.equal(used.length, 2);
      assert.ok(used[0].includes("STAGING_REVIEWER_TOKEN"));
      assert.ok(used[1].includes("STAGING_TOKEN"));
      for (const line of lines) {
        assert.ok(!line.includes(REVIEWER) && !line.includes(TOKEN));
      }
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
  const env = {
    CONTEXT: "branch-deploy", SITE_URL: "https://staging.test",
    STAGING_TOKEN: TOKEN,
  };

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
  const env = {
    CONTEXT: "branch-deploy", SITE_URL: "https://staging.test",
    STAGING_TOKEN: TOKEN,
  };
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

      // Ids since #253 have six characters; the old four still read.
      assert.deepEqual(tokenize("Order NFF-2610-K3WM7Q and NFF-2609-K3WM.")
        .filter((p) => p.token).map((p) => p.token),
      ["NFF-2610-K3WM7Q", "NFF-2609-K3WM"]);
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
        env: {
          CONTEXT: "deploy-preview", SITE_URL: "https://other.test",
          STAGING_TOKEN: TOKEN,
        },
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
      const other = await one(stores, "farm-pickup-changed");

      await call(stores, `/api/staging/emails/${ID}/rewrite`, "PUT", {
        version: e.version, subject: e.parts.subject,
        text: [{ text: "Sorry, " }, { token: "Dana" }, { text: "." }],
      });
      await call(stores, "/api/staging/emails/farm-pickup-changed/approval",
        "PUT", { version: other.version });
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
      assert.equal(by["farm-pickup-changed"].kind, "approval");
      assert.equal(by["farm-pickup-changed"].state, "port");
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

describe("the e2e endpoint (#266)", () => {
  const E2E = "e2e-s3cret";
  const env = {
    CONTEXT: "deploy-preview", MAIL_DRIVER: "outbox",
    STAGING_TOKEN: TOKEN, E2E_STAGING_TOKEN: E2E,
    URL: "https://staging.example.test",
  };
  const op = (body, token = E2E, method = "POST") => req(
    "/api/staging/e2e", method, body, { Authorization: `Bearer ${token}` }
  );
  const ask = async (stores, body, token) => {
    const res = await handle(op(body, token), { stores, env });

    return { status: res.status, body: await res.json() };
  };

  it("is a 404 on production and with no e2e token set", async () => {
    for (const e of [{ ...env, CONTEXT: "production" },
      { ...env, E2E_STAGING_TOKEN: "" }]) {
      const res = await handle(op({ op: "outboxList" }), {
        stores: testStores(), env: e,
      });

      assert.equal(res.status, 404);
    }
  });

  it("opens to its own token only, and shuts the toolbar's out", async () => {
    const stores = testStores();

    for (const token of ["", "wrong", TOKEN]) {
      assert.equal((await ask(stores, { op: "outboxList" }, token)).status,
        401, token);
    }

    assert.equal((await ask(stores, { op: "outboxList" })).status, 200);

    const toolbar = await handle(req("/api/staging/outbox", "GET", undefined, {
      Authorization: `Bearer ${E2E}`,
    }), { stores, env });

    assert.equal(toolbar.status, 401);

    const get = await handle(op(undefined, E2E, "GET"), { stores, env });

    assert.equal(get.status, 405);
  });

  it("refuses an unknown op", async () => {
    const r = await ask(testStores(), { op: "dropEverything" });

    assert.equal(r.status, 400);
  });

  it("reads and removes records, mail and messages", async () => {
    const stores = testStores();

    await stores.customers.set("messages/m1", {
      email: "pat@example.com", message: "Hi",
    });
    await stores.customers.set("messages/m2", {
      email: "lee@example.com", message: "Hi",
    });
    await sendMail({ ...message, to: "pat@example.com" }, {
      env: { MAIL_DRIVER: "outbox" }, stores,
    });

    const listed = await ask(stores, { op: "messagesList",
      email: "Pat@Example.com" });

    assert.deepEqual(listed.body.messages.map((m) => m.key), ["messages/m1"]);
    assert.equal((await ask(stores, { op: "outboxList" }))
      .body.messages.length, 1);

    assert.equal((await ask(stores, { op: "outboxClear",
      to: "pat@example.com", floor: "9999" })).body.removed, 0);
    assert.equal((await ask(stores, { op: "outboxClear",
      to: "pat@example.com" })).body.removed, 1);
    assert.equal((await ask(stores, { op: "messagesDelete",
      email: "pat@example.com" })).body.removed, 1);
    assert.equal((await stores.customers.list("messages/")).length, 1);
  });

  it("mints a sign-in link without mailing it", async () => {
    const stores = testStores();
    const r = await ask(stores, { op: "login", email: "pat@example.com" });

    assert.equal(r.status, 200);
    assert.match(r.body.url, /\/api\/auth\/verify\?token=/);
    assert.equal((await stores.jobs.list(OUTBOX_PREFIX)).length, 0);
    assert.equal((await ask(stores, { op: "login", email: "nope" })).status,
      400);
  });

  it("flips the maintenance switch and reports it", async () => {
    const stores = testStores();

    assert.equal((await ask(stores, { op: "maintenanceStatus" })).body.on,
      false);
    assert.equal((await ask(stores, { op: "maintenanceSet", on: true }))
      .body.changed, true);
    assert.equal((await ask(stores, { op: "maintenanceStatus" })).body.on,
      true);
    await ask(stores, { op: "maintenanceSet", on: false });
    assert.equal((await ask(stores, { op: "maintenanceLinks" })).body.links,
      null, "no MAINTENANCE_SECRET, no links");
  });

  it("answers 404 for a record that is not there", async () => {
    const stores = testStores();

    assert.equal((await ask(stores, { op: "orderShow", id: "NFF-0000-XXXXXX" }))
      .status, 404);
    assert.deepEqual((await ask(stores, { op: "ordersList",
      email: "none@example.com" })).body.orders, []);
  });
});
