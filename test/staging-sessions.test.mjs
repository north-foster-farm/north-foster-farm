// #294: the toolbar is every gate session's, and its mail is scoped to
// the session whose request wrote it. Nothing of it, and no sign-in
// link, reaches a visitor without a gate session; a tester never reads
// another session's mail, nor a sign-in link sent to someone else.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { handle as gateFunction } from "../netlify/functions/gate.mjs";
import { runAs, tagOf, within } from "../netlify/functions/lib/clock.mjs";
import { COOKIE, addAllow } from "../netlify/functions/lib/gate.mjs";
import { gateRequest } from "../netlify/functions/lib/gate-edge.mjs";
import { OUTBOX_PREFIX, sendMail } from "../netlify/functions/lib/mail.mjs";
import { testStores as plainStores } from "../netlify/functions/lib/store.mjs";
import {
  carriesSignIn, handle, ownLink,
} from "../netlify/functions/staging.mjs";

const OWNER = "james@example.com";
const PAT = "pat@example.com";
const JIM = "jim@example.com";
const IDS = {
  [OWNER]: "owner-session-id-0123456789abcdef",
  [PAT]: "pat-session-id-0123456789abcdefgh",
  [JIM]: "jim-session-id-0123456789abcdefgh",
};
const env = {
  SITE_CONTEXT: "branch-deploy", MAIL_DRIVER: "outbox",
  STAGING_TOKEN: "s3cret", GATE_TOOLBAR_EMAIL: OWNER,
};
const hash = (v) => createHash("sha256").update(v).digest("hex");

const testStores = () => {
  const stores = plainStores();

  for (const [email, id] of Object.entries(IDS)) {
    stores.gate.data.set(`allow/${email}`, { addedAt: "2026-10-18" });
    stores.gate.data.set(`session/${hash(id)}`, {
      email, createdAt: "2026-10-18", expires: Date.now() + 86_400_000,
    });
  }

  return stores;
};

const as = (email, path, method = "GET") => new Request(`https://x${path}`, {
  method,
  headers: email ? { Cookie: `${COOKIE}=${IDS[email]}` } : {},
});

const ask = async (stores, email, path, method) =>
  handle(as(email, path, method), { stores, env });

const listed = async (stores, email, path = "/api/staging/outbox") =>
  (await (await ask(stores, email, path)).json()).messages;

// A message written by `email`'s session, as a request of theirs would.
const sendAs = (stores, email, message) => runAs({ gate: IDS[email] },
  () => sendMail({ text: "Hello.", html: "", ...message }, { env, stores }));

const signInLink = (to) => ({
  to, subject: "Sign in",
  text: "Use https://x/api/auth/verify?token=abcdefghijklmnop to sign in.",
});

describe("what identifies a session's mail", () => {
  it("stamps an email with the gate session of the request", async () => {
    const stores = testStores();
    const req = as(PAT, "/api/orders", "POST");

    await within(req, () => sendMail({
      to: "a@example.com", subject: "Hi", text: "x",
    }, { env, stores }), env);

    const [key] = (await stores.jobs.list(OUTBOX_PREFIX)).map((k) => k.key);
    const saved = await stores.jobs.get(key);

    assert.equal(saved.session, await tagOf(IDS[PAT]));
    assert.notEqual(saved.session, hash(IDS[PAT]),
      "not the gate store's key for the session");
    assert.ok(!JSON.stringify(saved).includes(IDS[PAT]));
  });

  it("stamps nothing with no session: a webhook, a job, the CLI",
    async () => {
      const stores = testStores();

      await sendMail({ to: "a@example.com", subject: "Hi", text: "x" },
        { env, stores });
      await within(new Request("https://x/api/square/webhook"),
        () => sendMail({ to: "b@example.com", subject: "Hi", text: "x" },
          { env, stores }), env);

      for (const { key } of await stores.jobs.list(OUTBOX_PREFIX)) {
        assert.equal((await stores.jobs.get(key)).session, null);
      }
      assert.deepEqual(await listed(stores, PAT), []);
      assert.deepEqual(await listed(stores, OWNER), []);
    });

  it("is never read from a production request", async () => {
    const stores = testStores();

    await within(as(PAT, "/api/orders", "POST"), () => sendMail({
      to: "a@example.com", subject: "Hi", text: "x",
    }, { env, stores }), { SITE_CONTEXT: "production" });

    const [key] = (await stores.jobs.list(OUTBOX_PREFIX)).map((k) => k.key);

    assert.equal((await stores.jobs.get(key)).session, null);
  });
});

describe("a session's mail", () => {
  it("lists and opens only its own, newest first", async () => {
    const stores = testStores();

    await sendAs(stores, PAT, { to: "c1@example.com", subject: "Pat one" });
    await sendAs(stores, JIM, { to: "c2@example.com", subject: "Jim one" });
    await sendAs(stores, PAT, { to: "c3@example.com", subject: "Pat two" });

    const pat = await listed(stores, PAT);
    const jim = await listed(stores, JIM);

    assert.deepEqual(pat.map((m) => m.subject), ["Pat two", "Pat one"]);
    assert.deepEqual(jim.map((m) => m.subject), ["Jim one"]);

    const theirs = `/api/staging/outbox/${encodeURIComponent(jim[0].id)}`;

    assert.equal((await ask(stores, PAT, theirs)).status, 404);
    assert.equal((await ask(stores, PAT, `${theirs}?format=text`)).status,
      404);
    assert.equal((await ask(stores, JIM, theirs)).status, 200);
  });

  it("is the toolbar owner's own session's too; Sent has the rest",
    async () => {
      const stores = testStores();

      await sendAs(stores, PAT, { to: "c1@example.com", subject: "Pat's" });
      await sendAs(stores, OWNER, { to: "c2@example.com", subject: "Mine" });
      await sendMail({ to: "c3@example.com", subject: "A job's", text: "x" },
        { env, stores });

      assert.deepEqual((await listed(stores, OWNER)).map((m) => m.subject),
        ["Mine"]);
      assert.deepEqual(
        (await listed(stores, OWNER, "/api/staging/sent"))
          .map((m) => m.subject),
        ["A job's", "Mine", "Pat's"]);
      assert.equal((await ask(stores, PAT, "/api/staging/sent")).status,
        403, "Sent is James's alone");

      const pats = (await listed(stores, OWNER, "/api/staging/sent"))[2];

      assert.equal((await ask(stores, OWNER,
        `/api/staging/outbox/${encodeURIComponent(pats.id)}`)).status, 200);
    });

  it("is cleared alone: Clear leaves every other session's", async () => {
    const stores = testStores();

    await sendAs(stores, PAT, { to: "c1@example.com", subject: "Pat's" });
    await sendAs(stores, JIM, { to: "c2@example.com", subject: "Jim's" });

    const res = await ask(stores, PAT, "/api/staging/outbox", "DELETE");

    assert.equal((await res.json()).removed, 1);
    assert.deepEqual(await listed(stores, PAT), []);
    assert.equal((await listed(stores, JIM)).length, 1);
    assert.equal((await ask(stores, PAT, "/api/staging/sent", "DELETE"))
      .status, 403);
  });

  it("survives a customer signing in and out: only the gate's counts",
    async () => {
      const stores = testStores();

      await sendAs(stores, PAT, { to: "c1@example.com", subject: "Before" });

      // The shop's session cookie beside the gate's changes nothing.
      const withShop = new Request("https://x/api/staging/outbox", {
        headers: {
          Cookie: `nff_session=shop-session; ${COOKIE}=${IDS[PAT]}`,
        },
      });
      const res = await handle(withShop, { stores, env });

      assert.deepEqual((await res.json()).messages.map((m) => m.subject),
        ["Before"]);
    });
});

describe("sign-in links in the toolbar", () => {
  it("are found by content, the shop's and the gate's", () => {
    assert.ok(carriesSignIn(signInLink(PAT)));
    assert.ok(carriesSignIn({
      text: "", html: "<a href=\"https://x/api/gate/verify?token=t\">",
    }));
    assert.ok(!carriesSignIn({ text: "Your order is placed.", html: "" }));
  });

  it("are withheld from a session not their recipient's", async () => {
    const stores = testStores();

    // Pat, signed in to the gate, asks the shop for Jim's link.
    await sendAs(stores, PAT, signInLink(JIM));

    const [m] = await listed(stores, PAT);

    assert.equal(m.withheld, true);
    assert.equal(m.attachments, undefined);

    for (const path of [`/api/staging/outbox/${encodeURIComponent(m.id)}`,
      `/api/staging/outbox/${encodeURIComponent(m.id)}?format=text`,
      `/api/staging/outbox/${encodeURIComponent(m.id)}/attachments/a.pdf`]) {
      const res = await ask(stores, PAT, path);
      const body = await res.text();

      assert.equal(res.status, 404, path);
      assert.ok(!body.includes("abcdefghijklmnop"), path);
    }

    const list = await (await ask(stores, PAT, "/api/staging/outbox")).text();

    assert.ok(!list.includes("abcdefghijklmnop"));
  });

  it("open for their own recipient, +tags included, and for James",
    async () => {
      const stores = testStores();

      await sendAs(stores, PAT, signInLink("Pat+test@Example.com"));

      const [m] = await listed(stores, PAT);
      const path = `/api/staging/outbox/${encodeURIComponent(m.id)}`;

      assert.equal(m.withheld, undefined);
      assert.match(await (await ask(stores, PAT, `${path}?format=text`))
        .text(), /abcdefghijklmnop/);
      assert.equal((await ask(stores, OWNER, path)).status, 200);
    });

  it("are withheld when one recipient of several is someone else",
    async () => {
      const stores = testStores();

      await sendAs(stores, PAT, { ...signInLink([PAT, JIM]) });

      assert.equal((await listed(stores, PAT))[0].withheld, true);
    });

  it("are withheld by their sender's mark, whatever the text says",
    async () => {
      const stores = testStores();

      await sendAs(stores, PAT, {
        to: JIM, subject: "Sign in", text: "A link we wrapped oddly.",
        credential: true,
      });

      assert.equal((await listed(stores, PAT))[0].withheld, true);
    });

  it("cover farm news confirm and unsubscribe links too", () => {
    for (const text of [
      "Confirm: https://x/api/news/confirm?token=abc",
      "Off: https://x/api/news/unsubscribe?token=abc",
      "Off: https://x/news/?unsubscribe=abc",
    ]) {
      assert.ok(carriesSignIn({ text, html: "" }), text);
    }
  });

  it("are marked at the source: the shop's link and the news confirm",
    async () => {
      const { requestLink } = await import(
        "../netlify/functions/lib/auth.mjs");
      const { requestSubscribe, welcome } = await import(
        "../netlify/functions/lib/news.mjs");
      const sent = [];
      const mail = async (m) => { sent.push(m); };
      const stores = testStores();

      await requestLink(stores, { email: JIM }, { env, mail });
      await requestSubscribe(stores, { email: JIM }, { env, mail });
      await welcome(stores, {
        email: JIM, firstName: "Jim", marketingAt: "2026-10-21",
      }, { env, mail });
      assert.equal(sent.length, 3);
      for (const m of sent) assert.equal(m.credential, true, m.subject);
    });

  it("open to no one but James when the message names no recipient",
    async () => {
      // The outbox driver refuses such a message; a record could still
      // come to be some other way, so it is written as the outbox would.
      const stores = testStores();
      const session = await tagOf(IDS[PAT]);

      for (const [n, to] of [[1, []], [2, ""], [3, null]]) {
        await stores.jobs.set(`${OUTBOX_PREFIX}m${n}`, {
          ...signInLink(PAT), html: "",
          id: `m${n}`, at: "2026-10-21T12:00:00Z", session, to,
        });
      }

      const list = await listed(stores, PAT);

      assert.equal(list.length, 3);
      for (const m of list) assert.equal(m.withheld, true);
      assert.equal(ownLink({ to: [] }, { key: "owner session" }), true);
    });
});

describe("a tester's jobs run (#294 review)", () => {
  const DAY = 86_400_000;
  const run = (stores, body) => handle(new Request(
    "https://x/api/staging/jobs/run", {
      method: "POST",
      headers: {
        Cookie: `${COOKIE}=${IDS[PAT]}`, "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }), { stores, env });

  it("as of two years on sweeps nothing live", async () => {
    const stores = testStores();
    // Someone else's live customer session, good for 30 more days.
    const key = `session/${hash("jim-customer-session")}`;

    stores.auth.data.set(key, {
      email: JIM, expires: Date.now() + 30 * DAY,
    });

    const res = await run(stores, {
      at: new Date(Date.now() + 2 * 365 * DAY).toISOString(),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.authSwept, 0);
    assert.deepEqual(body.scrubbed, []);
    assert.ok(stores.auth.data.has(key), "jim's session lives");
  });

  it("refuses a time past what the clock may reach", async () => {
    for (const at of ["2099-01-01T12:00:00Z", "1990-01-01T12:00:00Z"]) {
      const res = await run(testStores(), { at });

      assert.equal(res.status, 400, at);
    }
  });
});

describe("before the gate (#294 hard rule)", () => {
  it("opens nothing of the toolbar's to a request with no session",
    async () => {
      const stores = testStores();

      await sendAs(stores, PAT, signInLink(PAT));

      for (const [method, path] of [["GET", "/api/staging/outbox"],
        ["GET", "/api/staging/sent"], ["GET", "/api/staging/emails"],
        ["GET", "/api/staging/info"], ["GET", "/api/staging/clock"],
        ["GET", "/api/staging/signatures"]]) {
        const bare = await ask(stores, null, path, method);

        assert.equal(bare.status, 401, path);
        assert.ok(!(await bare.text()).includes("verify"), path);

        // A session that has ended is no session.
        const ended = await handle(new Request(`https://x${path}`, {
          headers: { Cookie: `${COOKIE}=${"z".repeat(32)}` },
        }), { stores, env });

        assert.equal(ended.status, 401, path);
      }
    });

  it("is stopped at the edge, with the sign-in page and no toolbar",
    async () => {
      const store = plainStores().gate;
      let passed = false;
      const next = () => {
        passed = true;

        return new Response("toolbar");
      };

      for (const path of ["/api/staging/outbox", "/api/staging/emails",
        "/order/"]) {
        for (const accept of ["application/json", "text/html"]) {
          const res = await gateRequest(new Request(`https://x${path}`, {
            headers: { accept },
          }), {
            deploy: "branch-deploy", env: () => "", store: () => store, next,
          });
          const body = await res.text();

          assert.equal(res.status, 401, path);
          // (The page may name the path in its `next` field.)
          assert.ok(!/staging-toolbar|data-staging|[<]script|staging\.css/
            .test(body), `${path}: no toolbar on the gate's page`);
        }
      }
      assert.equal(passed, false);
    });

  it("never writes the gate's own link to the outbox or a page",
    async () => {
      const stores = testStores();
      const calls = [];
      const pending = [];

      await addAllow(stores.gate, PAT);

      const res = await gateFunction(new Request(
        "https://stg.example/api/gate/request", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: PAT }).toString(),
        }), {
        stores, ip: "1.1.1.1", after: (p) => pending.push(p),
        env: {
          ...env, GATE_RESEND_KEY: "re_gate_test",
          GATE_MAIL_FROM: "Staging <gate@example.com>",
        },
        fetchImpl: async (url, init) => {
          calls.push(JSON.parse(init.body));

          return new Response("{\"id\":\"m1\"}", { status: 200 });
        },
      });

      await Promise.all(pending);

      assert.equal(calls.length, 1, "mailed to the mailbox");
      assert.match(calls[0].text, /\/api\/gate\/verify\?token=/);
      assert.ok(!(await res.text()).includes("/api/gate/verify"),
        "the page that answers never shows it");
      assert.deepEqual(await stores.jobs.list(OUTBOX_PREFIX), [],
        "and the outbox never holds it");
    });
});
