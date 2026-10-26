import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  handle as paypalWebhook,
} from "../netlify/functions/paypal-webhook.mjs";
import {
  handle as squareWebhook,
} from "../netlify/functions/square-webhook.mjs";
import { handle as gateFunction, toolbarOwner }
  from "../netlify/functions/gate.mjs";
import {
  COOKIE, GATED, MACHINE_COOKIE, SESSION_TTL, addAllow, createSession,
  endSessions, gateActive, isAllowed, listAllow, parseEntry, removeAllow,
  requestLink, sessionFor, sessionKey, sha256, verifyToken,
} from "../netlify/functions/lib/gate.mjs";
import {
  EXEMPTIONS, NOINDEX, gateRequest,
} from "../netlify/functions/lib/gate-edge.mjs";
import { sendLink, SUBJECT } from "../netlify/functions/lib/gate-mail.mjs";
import { memoryStore, testStores } from "../netlify/functions/lib/store.mjs";

const root = join(import.meta.dirname, "..");
const NOW = new Date("2026-10-18T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const STAGING = { SITE_CONTEXT: "branch-deploy" };

describe("where the gate runs", () => {
  it("guards branch deploys and deploy previews, and nothing else", () => {
    assert.deepEqual(GATED, ["branch-deploy", "deploy-preview"]);
    for (const context of ["production", "", undefined, null, "dev",
      "scratch", "Production", "branch-deploy "]) {
      assert.equal(gateActive(context), false, `context ${context}`);
    }
    for (const context of GATED) assert.equal(gateActive(context), true);
  });

  it("is not in production's build, and is in the other two", () => {
    const toml = readFileSync(join(root, "netlify.toml"), "utf8");
    const [build] = toml.split("[build.environment]");
    const contexts = toml.split(/^\[context\./m).slice(1);

    assert.ok(!build.includes("install-gate"));
    assert.equal(contexts.length, 2);
    for (const c of contexts) assert.match(c, /install-gate\.mjs/);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"),
      /^netlify\/edge-functions\/$/m);
  });

  it("refuses to be installed by a production build", () => {
    for (const CONTEXT of ["production", "", "dev"]) {
      const run = spawnSync(process.execPath,
        [join(root, "bin/install-gate.mjs")], {
          env: { PATH: process.env.PATH, CONTEXT }, encoding: "utf8",
        });

      assert.equal(run.status, 1, `CONTEXT=${CONTEXT}`);
      assert.match(run.stderr, /not "/);
    }
  });

  it("answers 404 from its function in production and unset", async () => {
    for (const env of [{ SITE_CONTEXT: "production" }, {}]) {
      for (const [method, path] of [["GET", "/api/gate/signin"],
        ["POST", "/api/gate/request"], ["GET", "/api/gate/verify?token=x"],
        ["GET", "/api/gate/me"]]) {
        const res = await gateFunction(
          new Request(`https://x${path}`, { method }),
          { stores: testStores(), env },
        );

        assert.equal(res.status, 404, `${method} ${path}`);
      }
    }
  });

  it("lets production through the edge without opening a store", async () => {
    const boom = () => { throw new Error("a store was opened"); };

    for (const deploy of ["production", "", undefined]) {
      const res = await gateRequest(new Request("https://x/"), {
        deploy, env: boom, store: boom, next: () => new Response("page"),
      });

      assert.equal(res.status, 200);
      assert.equal(await res.text(), "page");
      assert.equal(res.headers.get("x-robots-tag"), null);
    }
  });
});

describe("the allowlist", () => {
  it("takes an exact address or a whole domain, lower-cased", () => {
    assert.equal(parseEntry(" Pat@Example.com "), "pat@example.com");
    assert.equal(parseEntry("@Example.com"), "@example.com");
    for (const bad of ["", "pat", "@", "@example", "pat@", "a b@x.com",
      "*@example.com", "example.com"]) {
      assert.equal(parseEntry(bad), null, bad);
    }
  });

  it("matches the exact address, and the domain but not its subdomains",
    async () => {
      const store = memoryStore();

      await addAllow(store, "pat@example.com", NOW);
      await addAllow(store, "@farm.org", NOW);

      assert.equal(await isAllowed(store, "PAT@example.com"), true);
      assert.equal(await isAllowed(store, "sam@example.com"), false);
      assert.equal(await isAllowed(store, "sam@farm.org"), true);
      assert.equal(await isAllowed(store, "sam@mail.farm.org"), false);
      assert.equal(await isAllowed(store, "sam@notfarm.org"), false);
      assert.equal(await isAllowed(store, "not an address"), false);
      assert.deepEqual((await listAllow(store)).map((e) => e.entry),
        ["@farm.org", "pat@example.com"]);
    });
});

describe("sessions", () => {
  it("last a year, are stored hashed, and die with the allowlist entry",
    async () => {
      const store = memoryStore();

      await addAllow(store, "pat@example.com", NOW);

      const id = await createSession(store, "Pat@example.com", NOW);
      const keys = (await store.list("session/")).map((k) => k.key);

      assert.equal(keys.length, 1);
      assert.ok(!keys[0].includes(id));
      assert.equal(keys[0], await sessionKey(id));
      assert.equal(SESSION_TTL, 365 * DAY);
      assert.deepEqual(await sessionFor(store, id, NOW),
        { email: "pat@example.com" });
      assert.equal(await sessionFor(store, id,
        new Date(NOW.getTime() + 364 * DAY)) !== null, true);
      assert.equal(await sessionFor(store, id,
        new Date(NOW.getTime() + 366 * DAY)), null);
    });

  it("ends by address, by domain entry and all at once", async () => {
    const store = memoryStore();

    for (const entry of ["pat@example.com", "@farm.org", "kim@other.com"]) {
      await addAllow(store, entry, NOW);
    }

    const pat = await createSession(store, "pat@example.com", NOW);
    const sam = await createSession(store, "sam@farm.org", NOW);
    const kim = await createSession(store, "kim@other.com", NOW);

    assert.equal(await endSessions(store, (e) => e === "pat@example.com"), 1);
    assert.equal(await sessionFor(store, pat, NOW), null);
    assert.notEqual(await sessionFor(store, sam, NOW), null);

    assert.deepEqual(await removeAllow(store, "@farm.org"),
      { entry: "@farm.org", ended: 1 });
    assert.equal(await sessionFor(store, sam, NOW), null);
    assert.notEqual(await sessionFor(store, kim, NOW), null);

    assert.equal(await endSessions(store), 1);
    assert.equal(await sessionFor(store, kim, NOW), null);
  });

  it("is dead the moment its address leaves the list, record or not",
    async () => {
      const store = memoryStore();

      await addAllow(store, "pat@example.com", NOW);

      const id = await createSession(store, "pat@example.com", NOW);

      await store.delete("allow/pat@example.com");
      assert.equal(await sessionFor(store, id, NOW), null);
    });

  it("rejects an id that is not shaped like one", async () => {
    const store = memoryStore();

    for (const id of [null, "", "short", "a".repeat(80), "bad id here!!"]) {
      assert.equal(await sessionFor(store, id, NOW), null);
    }
  });
});

describe("asking for a link", () => {
  const ask = (store, email, ip = "1.2.3.4", at = NOW) =>
    requestLink(store, { email, next: "/order/", ip }, { now: at });

  it("issues a one-use link for an address on the list only", async () => {
    const store = memoryStore();

    await addAllow(store, "pat@example.com", NOW);

    const unknown = await ask(store, "stranger@example.com");
    const known = await ask(store, "pat@example.com");

    assert.deepEqual(unknown, { issue: false });
    assert.equal(known.issue, true);
    assert.equal(known.email, "pat@example.com");

    const first = await verifyToken(store, known.token, { now: NOW });

    assert.deepEqual(first, { ok: true, email: "pat@example.com",
      next: "/order/" });
    assert.equal((await verifyToken(store, known.token, { now: NOW })).ok,
      false);
  });

  it("stores the link hashed and lets it expire", async () => {
    const store = memoryStore();

    await addAllow(store, "pat@example.com", NOW);

    const { token } = await ask(store, "pat@example.com");

    assert.ok(![...store.data.keys()].some((k) => k.includes(token)));
    assert.deepEqual(
      await verifyToken(store, token,
        { now: new Date(NOW.getTime() + 16 * 60_000) }),
      { ok: false, reason: "expired" },
    );
  });

  it("does not honor a link whose address has left the list", async () => {
    const store = memoryStore();

    await addAllow(store, "pat@example.com", NOW);

    const { token } = await ask(store, "pat@example.com");

    await removeAllow(store, "pat@example.com");
    assert.deepEqual(await verifyToken(store, token, { now: NOW }),
      { ok: false, reason: "removed" });
  });

  it("limits an address to three in fifteen minutes per requester, " +
    "listed or not", async () => {
    const store = memoryStore();

    await addAllow(store, "pat@example.com", NOW);

    const issued = [];

    for (let i = 0; i < 5; i++) {
      issued.push((await ask(store, "pat@example.com", "10.0.0.1")).issue);
    }
    assert.deepEqual(issued, [true, true, true, false, false]);
    // A stranger asking over and over for the same address cannot
    // lock its owner out: the owner's own allowance is untouched.
    assert.equal((await ask(store, "pat@example.com", "8.8.8.8")).issue,
      true);
    // The count is kept for an address nobody listed, so the limit
    // says nothing about the list.
    for (let i = 0; i < 5; i++) {
      await ask(store, "x@example.com", "9.9.9.9");
    }

    const key = `rate/address/${await sha256("9.9.9.9")}/x@example.com`;

    assert.equal((await store.get(key)).times.length, 5);
    assert.equal((await ask(store, "pat@example.com", "10.0.0.1",
      new Date(NOW.getTime() + 16 * 60_000))).issue, true);
  });

  it("limits an IP to ten in fifteen minutes across addresses", async () => {
    const store = memoryStore();

    await addAllow(store, "@example.com", NOW);

    let issued = 0;

    for (let i = 0; i < 14; i++) {
      if ((await ask(store, `u${i}@example.com`, "7.7.7.7")).issue) issued += 1;
    }
    assert.equal(issued, 10);
    assert.equal((await ask(store, "other@example.com", "6.6.6.6")).issue,
      true);
  });

  it("keeps no IP in the clear", async () => {
    const store = memoryStore();

    await ask(store, "x@example.com", "203.0.113.9");
    assert.ok(![...store.data.keys()].some((k) => k.includes("203.0.113.9")));
  });

  it("never lets next point off the site or back at the gate", async () => {
    const store = memoryStore();

    await addAllow(store, "@example.com", NOW);

    let n = 0;

    for (const next of ["https://evil.example/", "//evil.example",
      "/\\evil", "/api/gate/signin", "/\t/evil.example",
      "/\n/evil.example", "/\r/evil.example"]) {
      n += 1;

      const { token } = await requestLink(store,
        { email: `u${n}@example.com`, next, ip: `10.0.0.${n}` },
        { now: NOW });
      const done = await verifyToken(store, token, { now: NOW });

      assert.equal(done.next, "/", next);
    }
  });
});

describe("the gate's function", () => {
  const post = (path, fields) => new Request(`https://stg.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const mailEnv = {
    ...STAGING, GATE_RESEND_KEY: "re_gate_test",
    GATE_MAIL_FROM: "Staging <gate@example.com>",
  };
  const spy = () => {
    const calls = [];

    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });

        return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
      },
    };
  };
  const run = async (stores, fields, extra = {}) => {
    const pending = [];
    const res = await gateFunction(post("/api/gate/request", fields), {
      stores, env: mailEnv, now: NOW, ip: "1.1.1.1",
      after: (p) => pending.push(p), ...extra,
    });

    await Promise.all(pending);

    return res;
  };

  it("answers the same for an address on the list and one off it",
    async () => {
      const stores = testStores();
      const { calls, fetchImpl } = spy();

      await addAllow(stores.gate, "pat@example.com", NOW);

      const on = await run(stores, { email: "pat@example.com" }, { fetchImpl });
      const off = await run(stores, { email: "who@example.com" },
        { fetchImpl });

      assert.equal(on.status, 200);
      assert.equal(off.status, on.status);
      assert.equal(await off.text(), await on.text());
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0].init.body).to, ["pat@example.com"]);
    });

  it("mails after the answer, so timing does not give the list away",
    async () => {
      const stores = testStores();
      const { calls, fetchImpl } = spy();

      await addAllow(stores.gate, "pat@example.com", NOW);

      const pending = [];

      await gateFunction(post("/api/gate/request",
        { email: "pat@example.com" }), {
        stores, env: mailEnv, now: NOW, fetchImpl,
        after: (p) => pending.push(p),
      });
      assert.equal(pending.length, 1);
      await Promise.all(pending);
      assert.equal(calls.length, 1);
    });

  it("sends nothing for the honeypot, a bad address or a rate limit",
    async () => {
      const stores = testStores();
      const { calls, fetchImpl } = spy();

      await addAllow(stores.gate, "pat@example.com", NOW);
      await run(stores, { email: "pat@example.com", website: "x" },
        { fetchImpl });
      await run(stores, { email: "not an email" }, { fetchImpl });
      assert.equal(calls.length, 0);
      for (let i = 0; i < 5; i++) {
        await run(stores, { email: "pat@example.com" }, {
          fetchImpl, ip: "5.5.5.5",
        });
      }
      assert.equal(calls.length, 3);
    });

  it("signs in with the link, once, with a year-long cookie", async () => {
    const stores = testStores();
    const { fetchImpl } = spy();

    await addAllow(stores.gate, "pat@example.com", NOW);
    await run(stores, { email: "pat@example.com", next: "/order/" },
      { fetchImpl });

    const [{ key }] = await stores.gate.list("token/");
    const { email } = await stores.gate.get(key);
    const { token } = await requestLink(stores.gate,
      { email, next: "/order/", ip: "4.4.4.4" }, { now: NOW });
    const url = `https://stg.example/api/gate/verify?token=${token}`;
    const res = await gateFunction(new Request(url), {
      stores, env: STAGING, now: NOW,
    });

    assert.equal(res.status, 302);
    // The empty query keeps Netlify from copying the token onto it.
    assert.equal(res.headers.get("location"), "/order/?");

    const cookie = res.headers.get("set-cookie");

    assert.match(cookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{20,}; Path=/; `
      + "HttpOnly; Secure; SameSite=Lax; Max-Age=31536000$"));

    const again = await gateFunction(new Request(url), {
      stores, env: STAGING, now: NOW,
    });

    assert.equal(again.status, 401);
    assert.equal(again.headers.get("set-cookie"), null);
  });

  it("opens the toolbar only for the address in config", async () => {
    assert.equal(toolbarOwner("Jim@Example.com",
      { GATE_TOOLBAR_EMAIL: "jim@example.com" }), true);
    assert.equal(toolbarOwner("pat@example.com",
      { GATE_TOOLBAR_EMAIL: "jim@example.com" }), false);
    assert.equal(toolbarOwner("pat@example.com", {}), false);
    assert.equal(toolbarOwner("", { GATE_TOOLBAR_EMAIL: "" }), false);
  });

  it("signs out by ending the session", async () => {
    const stores = testStores();

    await addAllow(stores.gate, "pat@example.com", NOW);

    const id = await createSession(stores.gate, "pat@example.com", NOW);
    const res = await gateFunction(new Request("https://x/api/gate/signout", {
      method: "POST", headers: { cookie: `${COOKIE}=${id}` },
    }), { stores, env: STAGING, now: NOW });

    assert.equal(res.status, 302);
    assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(await sessionFor(stores.gate, id, NOW), null);
  });
});

describe("the sign-in email", () => {
  const stores = async (...entries) => {
    const s = testStores();

    for (const e of entries) await addAllow(s.gate, e, NOW);

    return s;
  };
  const env = {
    ...STAGING, GATE_RESEND_KEY: "re_gate_test", RESEND_API_KEY: "re_prod",
    GATE_MAIL_FROM: "Staging <gate@example.com>",
  };
  const spy = () => {
    const calls = [];

    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });

        return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
      },
    };
  };
  const link = (to) => ({ to, url: "https://stg.example/api/gate/verify?t=1" });

  it("is plain text, under its own key, to one allowlisted address",
    async () => {
      const s = await stores("pat@example.com");
      const { calls, fetchImpl } = spy();
      const out = await sendLink(link("pat@example.com"),
        { env, stores: s, fetchImpl, now: NOW });

      assert.deepEqual(out, { sent: true, id: "m1" });
      assert.equal(calls[0].url, "https://api.resend.com/emails");
      assert.equal(calls[0].init.headers.Authorization,
        "Bearer re_gate_test");

      const body = JSON.parse(calls[0].init.body);

      assert.equal(body.subject,
        "Your secure sign-in link to [STAGING] North Foster Farm");
      assert.equal(body.subject, SUBJECT);
      assert.match(body.text, /^Sign in to \[STAGING\] North Foster Farm\n/);
      assert.ok(body.text.includes(
        "\nClick the link below to sign in to " +
        "[STAGING] North Foster Farm. The link expires in 15 minutes.\n",
      ));
      assert.ok(body.text.includes(
        "\nIf you didn't request this email, you can safely ignore it.\n",
      ));
      assert.deepEqual(body.to, ["pat@example.com"]);
      assert.equal(body.html, undefined);
      assert.match(body.text, /verify\?t=1/);
    });

  it("refuses a recipient who is not on the list", async () => {
    const s = await stores("pat@example.com");
    const { calls, fetchImpl } = spy();

    assert.deepEqual(
      await sendLink(link("who@example.com"),
        { env, stores: s, fetchImpl, now: NOW }),
      { sent: false, reason: "not-allowed" },
    );
    assert.equal(calls.length, 0);
  });

  it("never runs in production, or with a key missing", async () => {
    const s = await stores("pat@example.com");
    const { calls, fetchImpl } = spy();

    for (const context of ["production", "", "dev"]) {
      const out = await sendLink(link("pat@example.com"), {
        env: { ...env, SITE_CONTEXT: context }, stores: s, fetchImpl,
      });

      assert.equal(out.sent, false, context);
    }
    for (const lacking of ["GATE_RESEND_KEY", "GATE_MAIL_FROM"]) {
      const out = await sendLink(link("pat@example.com"), {
        env: { ...env, [lacking]: "" }, stores: s, fetchImpl,
      });

      assert.deepEqual(out, { sent: false, reason: "unconfigured" });
    }
    // Production's key is never the fallback.
    const out = await sendLink(link("pat@example.com"), {
      env: { ...env, GATE_RESEND_KEY: "" }, stores: s, fetchImpl,
    });

    assert.equal(out.sent, false);
    assert.equal(calls.length, 0);
  });

  it("stops at its own low ceiling, then trips the breaker", async () => {
    const s = await stores("@example.com");
    const { calls, fetchImpl } = spy();
    const results = [];

    for (let i = 0; i < 8; i++) {
      results.push((await sendLink(link(`u${i}@example.com`),
        { env, stores: s, fetchImpl, now: NOW })).sent);
    }
    assert.deepEqual(results,
      [true, true, true, true, true, true, false, false]);
    assert.equal(calls.length, 6);

    const state = await s.jobs.get("breaker/state");

    assert.equal(state.reason, "volume");
    // Nothing refused is held for a later flush.
    assert.equal((await s.jobs.list("breaker/unsent/")).length, 0);
  });

  it("stays shut if the breaker's store cannot answer", async () => {
    const s = await stores("pat@example.com");
    const { calls, fetchImpl } = spy();

    s.jobs = { ...s.jobs, get: async () => { throw new Error("down"); } };

    const out = await sendLink(link("pat@example.com"),
      { env, stores: s, fetchImpl, now: NOW });

    assert.deepEqual(out, { sent: false, reason: "unavailable" });
    assert.equal(calls.length, 0);
  });

  it("does not throw when Resend fails", async () => {
    const s = await stores("pat@example.com");
    const fetchImpl = async () => new Response("{}", { status: 500 });
    const out = await sendLink(link("pat@example.com"),
      { env, stores: s, fetchImpl, now: NOW });

    assert.deepEqual(out, { sent: false, reason: "failed" });
  });
});

describe("the edge", () => {
  const next = () => new Response("page", { status: 200 });
  const env = (values = {}) => (name) => values[name];
  const keys = { STAGING_TOKEN: "stg-token", E2E_STAGING_TOKEN: "e2e-token" };
  const edge = async (path, { deploy = "branch-deploy", headers = {},
    method = "GET", store = memoryStore(), values = keys } = {}) =>
    gateRequest(new Request(`https://stg.example${path}`, { method, headers }), {
      deploy, env: env(values), store: () => store, next, now: NOW,
    });

  it("stops an anonymous visitor with the sign-in page, in both contexts",
    async () => {
      for (const deploy of GATED) {
        const res = await edge("/order/", {
          deploy, headers: { accept: "text/html,application/xhtml+xml" },
        });

        assert.equal(res.status, 401);
        assert.match(res.headers.get("content-type"), /text\/html/);
        assert.equal(res.headers.get("x-robots-tag"), NOINDEX);
        assert.equal(res.headers.get("cache-control"), "no-store");

        const page = await res.text();

        assert.match(page, /action="\/api\/gate\/request"/);
        assert.match(page, /name="next" value="\/order\/"/);
        assert.ok(!page.includes("page"));
      }
    });

  it("gives a script a bare 401 and a pinger nothing", async () => {
    const res = await edge("/api/orders", { method: "POST" });

    assert.equal(res.status, 401);
    assert.equal(await res.text(), "Sign in required.\n");
    assert.equal(res.headers.get("x-robots-tag"), NOINDEX);
  });

  it("escapes the path it hands back to the sign-in form", async () => {
    const res = await edge('/x"><script>alert(1)</script>', {
      headers: { accept: "text/html" },
    });

    assert.ok(!(await res.text()).includes("<script>alert"));
  });

  it("passes a live session, marked noindex", async () => {
    const store = memoryStore();

    await addAllow(store, "pat@example.com", NOW);

    const id = await createSession(store, "pat@example.com", NOW);
    const res = await edge("/order/", {
      store, headers: { cookie: `a=b; ${COOKIE}=${id}` },
    });

    assert.equal(res.status, 200);
    assert.equal(await res.text(), "page");
    assert.equal(res.headers.get("x-robots-tag"), NOINDEX);
  });

  it("stops a forged, expired or removed session", async () => {
    const store = memoryStore();

    await addAllow(store, "pat@example.com", NOW);

    const id = await createSession(store, "pat@example.com", NOW);

    assert.equal((await edge("/", { store,
      headers: { cookie: `${COOKIE}=${"x".repeat(43)}` } })).status, 401);
    await removeAllow(store, "pat@example.com");
    assert.equal((await edge("/", { store,
      headers: { cookie: `${COOKIE}=${id}` } })).status, 401);
  });

  it("marks noindex where the gate is off but the context is not production",
    async () => {
      const res = await edge("/", { deploy: "dev" });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-robots-tag"), NOINDEX);
    });

  it("opens the sign-in paths to anyone", async () => {
    for (const path of ["/api/gate/signin", "/api/gate/request",
      "/api/gate/verify"]) {
      assert.equal((await edge(path)).status, 200, path);
    }
  });

  describe("machine access", () => {
    const bearer = (token) => ({ authorization: `Bearer ${token}` });

    it("lists exactly these exemptions", () => {
      assert.deepEqual(EXEMPTIONS.map((e) => [e.name, e.credential, e.env]), [
        ["sign-in", "sign-in", undefined],
        ["Square sandbox webhook", "signature", undefined],
        ["PayPal sandbox webhook", "signature", undefined],
        ["staging jobs workflow", "token", "STAGING_TOKEN"],
        ["health check", "token", "STAGING_TOKEN"],
        ["build version", "none", undefined],
        ["end-to-end suite", "token", "E2E_STAGING_TOKEN"],
      ]);
    });

    it("opens /version.json to anyone, and no other path", async () => {
      const res = await edge("/version.json", { values: {} });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-robots-tag"), NOINDEX);

      for (const path of ["/version.json/", "/version.jsonx", "/version",
        "/version.json.map", "/a/version.json", "/VERSION.JSON",
        "/version.json/x", "/", "/api/orders", "/llms.txt"]) {
        assert.equal((await edge(path, { values: {} })).status, 401, path);
      }
    });

    for (const path of ["/api/staging/jobs/run", "/api/health"]) {
      it(`${path} is closed without STAGING_TOKEN, open with it`, async () => {
        assert.equal((await edge(path)).status, 401);
        assert.equal((await edge(path, { headers: bearer("wrong") })).status,
          401);
        assert.equal(
          (await edge(path, { headers: bearer("e2e-token") })).status,
          200, "the e2e token is not the jobs token, but it opens every path");
        assert.equal(
          (await edge(path, { headers: bearer("stg-token") })).status,
          200);
      });
    }

    it("closes both token paths when the variable is unset or empty",
      async () => {
        for (const values of [{},
          { STAGING_TOKEN: "", E2E_STAGING_TOKEN: "" }]) {
          for (const headers of [{}, bearer(""), { "x-staging-token": "" },
            bearer("undefined")]) {
            assert.equal((await edge("/api/staging/jobs/run",
              { values, headers })).status, 401);
            assert.equal((await edge("/order/", { values, headers })).status,
              401);
          }
        }
      });

    it("STAGING_TOKEN opens only its two paths", async () => {
      for (const path of ["/", "/order/", "/api/orders",
        "/api/staging/outbox", "/api/staging/e2e", "/api/me"]) {
        assert.equal(
          (await edge(path, { headers: bearer("stg-token") })).status,
          401, path);
      }
    });

    it("the e2e token opens every path, by header or machine cookie",
      async () => {
        for (const path of ["/", "/order/", "/api/orders"]) {
          assert.equal((await edge(path,
            { headers: { "x-staging-token": "e2e-token" } })).status, 200);
          assert.equal((await edge(path,
            { headers: { cookie: `${MACHINE_COOKIE}=e2e-token` } })).status,
          200);
          assert.equal((await edge(path,
            { headers: { cookie: `${MACHINE_COOKIE}=stg-token` } })).status,
          401);
        }
      });

    it("passes a webhook to its function, which refuses what is unsigned",
      async () => {
        for (const path of ["/api/square/webhook", "/api/paypal/webhook"]) {
          assert.equal((await edge(path, { method: "POST" })).status, 200);
        }

        const body = JSON.stringify({ type: "refund.updated" });
        const square = await squareWebhook(
          new Request("https://x/api/square/webhook", { method: "POST", body }),
          { stores: testStores(), env: STAGING },
        );
        const forged = await squareWebhook(
          new Request("https://x/api/square/webhook", {
            method: "POST", body,
            headers: { "x-square-hmacsha256-signature": "forged" },
          }),
          { stores: testStores(),
            env: { ...STAGING, SQUARE_WEBHOOK_SIGNATURE_KEY: "k" } },
        );
        const paypal = await paypalWebhook(
          new Request("https://x/api/paypal/webhook", { method: "POST", body }),
          { stores: testStores(), env: STAGING },
        );

        assert.equal(square.status, 401);
        assert.equal(forged.status, 401);
        assert.equal(paypal.status, 401);
      });

    it("marks every machine response noindex too", async () => {
      const res = await edge("/api/square/webhook", { method: "POST" });

      assert.equal(res.headers.get("x-robots-tag"), NOINDEX);
    });
  });
});
