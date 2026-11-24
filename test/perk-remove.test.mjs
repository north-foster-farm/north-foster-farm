// Criteria tests for #758 (Invite-made customers can't be found to
// remove a perk), one per "Done when" box marked (test), each named for
// its box. Written before the code, by a test agent; the implementer
// turns the file on by renaming it to perk-remove.test.mjs.
//
// The customer is made the way the staging one was: an invite the farm
// makes (lib/invites.mjs addInvite, as `bin/nff invite add`), the
// address the person types on the invite page (POST
// /api/invite/request), and the sign-in link that follows (GET
// /api/auth/verify, which signs in and runs finishInvite, #718). Then
// the farm's three commands, through the functions bin/nff calls for
// them:
//
//   perks list       lib/perks.mjs listPerks(stores, { email })
//   customers show   lib/admin.mjs showCustomer(stores, email)
//   perks remove     lib/perks.mjs removePerk(stores, email, type)
//
// The two box tests share one set of memory stores (testStores), as the
// existing perk and invite tests do. On staging the sign-in writes
// through the functions' Blobs client (the edge URL) and the commands
// read through the CLI's (the API's signed URL), and the record the
// sign-in made for james+dog@... is stored as "james dog@..." (the
// read-only checks on staging, 2026-11-21, on #758): the edge route
// reads a raw "+" in the path as a space, and the two routes disagree
// on an encoded one. So address-keyed records move to a hash of the
// address (#758's key scheme, James, 2026-11-21). The third test holds
// both routes to that key, from the request each sends: it spies on
// fetch and throws before any answer, so no response is faked. The
// fourth holds every address a function or the CLI takes to one
// decode, cleaning and validation, and the fifth the CLI step that
// moves a record from the key it sits under today to its hashed one.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { showCustomer } from "../netlify/functions/lib/admin.mjs";
import { addInvite } from "../netlify/functions/lib/invites.mjs";
import {
  listPerks, removePerk,
} from "../netlify/functions/lib/perks.mjs";
import { creditKey, getLedger } from "../netlify/functions/lib/credit.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import {
  cartKey, getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import {
  storeName, stores as makeStores, testStores,
} from "../netlify/functions/lib/store.mjs";

const now = instant("2026-11-21", 9, 0, "America/New_York");
const ENV = { URL: "https://x" };
const PERK = "free-delivery";

// A plus address and a mixed-case one, as the person types them.
const PLUS = "pat+dog@example.com";
const MIXED = "Sam.Example@Example.COM";

// The key segment of an address-keyed record, from #758's definition:
// base64url(SHA-256(normalized address)), no padding.
const hashed = (email) => createHash("sha256")
  .update(String(email).trim().toLowerCase()).digest("base64url");

const quiet = (t) => {
  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, () => {});
  }
};

const post = (path, body) => new Request(`https://x${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json", "sec-fetch-site": "same-origin",
  },
  body: JSON.stringify(body),
});

// The farm's invite, asked for with `email` and followed: the
// customer record the sign-in makes, with the invite's perk on it.
const signUpByInvite = async (stores, email) => {
  const { handle } = await import("../netlify/functions/invite.mjs");
  const { url } = await addInvite(stores, PERK, { by: "cli", now, env: ENV });
  const token = new URL(url).searchParams.get("t");
  const sent = [];
  const asked = await handle(post("/api/invite/request", { token, email }), {
    stores, env: ENV, now, ip: "",
    mail: async (m) => {
      sent.push(m);

      return { id: "m1", driver: "test" };
    },
  });

  assert.equal(asked.status, 200, "the invite page took the address");

  const found = JSON.stringify(sent)
    .match(/\/api\/auth\/verify\?token=([A-Za-z0-9_-]+)/);

  assert.ok(found, "a sign-in link was mailed");

  const res = await authHandle(
    new Request(`https://x/api/auth/verify?token=${found[1]}`),
    { stores, env: ENV, now },
  );

  assert.equal(res.status, 302, "the link signed the person in");
};

const active = (rows, type) => rows.filter((r) => r.type === type
  && r.state === "active");

describe("#758 perks on invite-made customers", () => {
  it("A perk granted through an invite to a plus address (and a "
    + "mixed-case address) can be listed, shown and removed with "
    + "`bin/nff perks list`, `customers show` and `perks remove` (test)",
  async (t) => {
    quiet(t);

    for (const email of [PLUS, MIXED]) {
      const stores = testStores();

      await signUpByInvite(stores, email);

      // Listed (perks list), whole and for the address as typed.
      const all = active(await listPerks(stores, { now }), PERK);

      assert.equal(all.length, 1, `${email}: perks list shows the perk`);
      assert.equal(
        active(await listPerks(stores, { email, now }), PERK).length, 1,
        `${email}: perks list <address> shows the perk`,
      );

      // Shown (customers show), with the address as typed.
      const shown = await showCustomer(stores, email);

      assert.ok(shown.customer, `${email}: customers show finds the record`);
      assert.equal(
        shown.customer.email, all[0].email,
        `${email}: customers show finds the record perks list shows`,
      );

      // Removed (perks remove), with the address as typed.
      const removed = await removePerk(stores, email, PERK, { now });

      assert.equal(removed.perk.type, PERK, `${email}: perks remove ran`);
      assert.ok(removed.perk.removedAt, `${email}: the perk is dated removed`);

      const after = await listPerks(stores, { now });

      assert.equal(active(after, PERK).length, 0,
        `${email}: no active ${PERK} perk is left`);
      assert.deepEqual(after.map((r) => r.state), ["removed"],
        `${email}: perks list shows the perk as removed`);
    }
  });

  it("Every customer the perks list shows can be found by `customers "
    + "show` with the address the list prints (test)", async (t) => {
    quiet(t);

    const stores = testStores();

    for (const email of [PLUS, MIXED]) await signUpByInvite(stores, email);

    const rows = await listPerks(stores, { now });

    assert.equal(rows.length, 2, "perks list shows both invite perks");

    for (const row of rows) {
      const shown = await showCustomer(stores, row.email);

      assert.ok(shown.customer, `customers show finds ${row.email}`);
      assert.equal(shown.customer.email, row.email,
        `customers show ${row.email} is that customer's record`);
    }
  });

  it("Every address-keyed record is stored and found under "
    + "base64url(SHA-256(normalized address)) on both the CLI's route "
    + "and the functions' route, plain and plus addresses alike, and "
    + "every key segment sent is URL-encoded (a no-op for these keys) "
    + "(test)", async (t) => {
    quiet(t);

    // The key scheme (James, 2026-11-21, #758): the two Blobs routes
    // disagree on an encoded path, so an address-keyed record sits
    // under a URL-safe hash of its address, the same form in every
    // address-keyed store. The expected key is worked out here from
    // that definition, never by the code under test. Each "/" segment
    // still goes through encodeURIComponent, a no-op for these keys.
    const SITE = "site-id-1";
    const CONTEXT = "branch-deploy";
    const store = storeName("customers", { SITE_CONTEXT: CONTEXT });
    const encoded = (key) => key.split("/").map(encodeURIComponent)
      .join("/");

    assert.equal(hashed("  Pat+Dog@Example.com "),
      "AMHJL0NpSgypWjP7ZvFu2gI3Hkwk2WSW5957fBpZ6LA",
      "the test's hash is the issue's example");

    // Each call names an address; the key it must send, by kind.
    const cases = [PLUS, "pat@example.com"].flatMap((email) => [
      ["customer get", `customer/${hashed(email)}`,
        (s) => getCustomer(s, email)],
      ["customer set", `customer/${hashed(email)}`,
        (s) => saveCustomer(s, { email, consent: [] })],
      ["cart get", `cart/${hashed(email)}`,
        (s) => s.customers.get(cartKey(email))],
      ["cart set", `cart/${hashed(email)}`,
        (s) => s.customers.set(cartKey(email), { lines: [] })],
      ["credit get", `credit/${hashed(email)}`,
        (s) => getLedger(s, email)],
      ["credit set", `credit/${hashed(email)}`,
        (s) => s.customers.set(creditKey(email), { entries: [] })],
    ].map(([op, key, call]) => ({ email, op, key, call })));

    for (const { key } of cases) {
      assert.match(key.split("/").pop(), /^[A-Za-z0-9_-]{43}$/,
        `${key}: 43 URL-safe characters`);
    }

    // The first request either route makes for a call, then a refusal
    // before any answer. The client retries a refused request after a
    // timer, so timers are mocked: a retry never fires.
    const urls = [];

    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(globalThis, "fetch", async (url) => {
      urls.push(String(url));
      throw new Error("no network in this test");
    });

    const firstUrl = async (call) => {
      const from = urls.length;

      call().catch(() => {});
      for (let i = 0; i < 50 && urls.length === from; i += 1) {
        await new Promise((done) => {
          setImmediate(done);
        });
      }
      assert.ok(urls.length > from, "the store made a request");

      return new URL(urls[from]);
    };

    // The Blobs client reads the functions' context when a store is
    // made, so it is set for that route alone.
    const blobsContext = Buffer.from(JSON.stringify({
      siteID: SITE, token: "token-1", edgeURL: "https://edge.example",
      uncachedEdgeURL: "https://uncached-edge.example",
    })).toString("base64");
    const before = globalThis.netlifyBlobsContext;
    const withContext = (on) => {
      if (on) globalThis.netlifyBlobsContext = blobsContext;
      else delete globalThis.netlifyBlobsContext;
    };

    t.after(() => {
      if (before === undefined) delete globalThis.netlifyBlobsContext;
      else globalThis.netlifyBlobsContext = before;
    });

    const routes = {
      // The CLI: a site id and token, the API route.
      cli: () => {
        withContext(false);

        return makeStores({
          SITE_CONTEXT: CONTEXT, NETLIFY_SITE_ID: SITE,
          NETLIFY_AUTH_TOKEN: "token-1",
        });
      },
      // A function on Netlify: the Blobs context, the edge route.
      functions: () => {
        withContext(true);

        return makeStores({ SITE_CONTEXT: CONTEXT });
      },
    };

    for (const [route, make] of Object.entries(routes)) {
      const made = make();

      for (const { email, op, key, call } of cases) {
        const url = await firstUrl(() => call(made));
        const where = `${route} ${op} ${email}`;
        const path = encoded(key);

        // The client names the store `site:<name>` in the path.
        assert.ok(url.pathname.endsWith(`${store}/${path}`),
          `${where}: path ${url.pathname} ends ${store}/${path}`);
      }
    }
  });

  it("Every address a function or the CLI receives is URL-decoded once, "
    + "then sanitized (trimmed, lowercased, no whitespace or control "
    + "characters) and validated as an email address before it is used "
    + "or becomes part of a key; one that fails is refused with a clear "
    + "error (a 400 from a function, a non-zero exit from the CLI), "
    + "never treated as a missing record (test)", async (t) => {
    quiet(t);

    // A function: the invite page's POST /api/invite/request, the
    // endpoint that made the staging record. Encoded once, or padded
    // and in capitals, the address is decoded, cleaned and used: the
    // record the sign-in makes is under its hashed key.
    const plusKey = `customer/${hashed(PLUS)}`;

    for (const typed of ["pat%2Bdog%40example.com",
      "  Pat+Dog@Example.COM "]) {
      const stores = testStores();

      await signUpByInvite(stores, typed);

      const record = await stores.customers.get(plusKey);

      assert.equal(record && record.email, PLUS,
        `${JSON.stringify(typed)}: stored as ${plusKey}`);

      const keys = (await stores.customers.list("customer/"))
        .map((e) => e.key);

      assert.deepEqual(keys, [plusKey],
        `${JSON.stringify(typed)}: no record under another key`);
    }

    // Encoded twice (still encoded after one decode), or not an
    // address, it is refused as a client error with the email named.
    // The site's forms take field errors as a 422, which this counts
    // as the box's 400; a 404 or a 5xx does not.
    for (const typed of ["pat%252Bdog%2540example.com",
      "pat%2Bdog%2540example.com", "pat\u0007dog@example.com",
      "not an address"]) {
      const stores = testStores();
      const { handle } = await import("../netlify/functions/invite.mjs");
      const { url } = await addInvite(stores, PERK, {
        by: "cli", now, env: ENV,
      });
      const token = new URL(url).searchParams.get("t");
      const res = await handle(post("/api/invite/request", {
        token, email: typed,
      }), {
        stores, env: ENV, now, ip: "",
        mail: async () => ({ id: "m1", driver: "test" }),
      });
      const where = JSON.stringify(typed);

      assert.ok([400, 422].includes(res.status),
        `${where}: refused as a client error, not ${res.status}`);
      assert.ok((await res.json()).errors.email,
        `${where}: the error names the email address`);
    }

    // The CLI: `bin/nff customers show`, run with no context, so its
    // stores are memory and empty. An address valid after one decode
    // is looked up, and missed as a missing record. One that fails is
    // refused, non-zero, as an address, never as a missing record.
    const root = new URL("..", import.meta.url).pathname;
    const home = mkdtempSync(join(tmpdir(), "nff-758-"));

    t.after(() => rmSync(home, { recursive: true, force: true }));

    const show = (address) => spawnSync(process.execPath, [
      join(root, "bin", "nff"), "customers", "show", address,
    ], {
      cwd: root, encoding: "utf8", timeout: 60_000,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home, TZ: "America/New_York",
      },
    });
    const missing = /No such customer/;
    const once = show("member%40james.com");

    assert.match(`${once.stdout}${once.stderr}`, missing,
      "an address encoded once is decoded and looked up");
    for (const address of ["member%2540james.com", "member at james.com",
      "member\u0007@james.com"]) {
      const ran = show(address);
      const said = `${ran.stdout}${ran.stderr}`;

      assert.notEqual(ran.status, 0, `${address}: a non-zero exit`);
      assert.doesNotMatch(said, missing,
        `${address}: not treated as a missing record`);
      assert.match(said, /email|address/i,
        `${address}: the error says the address is not valid`);
    }
  });

  it("Every existing address-keyed record (customers, carts, credit, "
    + "support messages, the orders-by-address index), whatever key it "
    + "sits under today (the raw address, or a space for a \"+\"), is "
    + "moved to its hashed key by a CLI step, dry run first, one masked "
    + "log line per move, refusing when the new key already holds a "
    + "record (test)", async (t) => {
    // The CLI step is `bin/nff customers rekey [--apply]`, which calls
    // lib/rekey.mjs rekeyRecords(stores, { apply, by }) and prints what
    // it returns: a dry run unless `apply`, and the moves it refused
    // as `refused`. Imported here, so the rest of the file runs before
    // the step exists.
    const { rekeyRecords } = await import(
      "../netlify/functions/lib/rekey.mjs"
    );
    const lines = [];

    quiet(t);
    console.info.mock.mockImplementation((text) => {
      lines.push(String(text));
    });

    // Two customers as staging may hold them today: one under the
    // space its "+" became, one under its raw address, each with a
    // cart and a support message keyed the same way.
    const SPACED = "pat dog@example.com";
    const RAW = "sam@example.com";
    const moves = [[SPACED, PLUS], [RAW, RAW]].flatMap(([today, email]) => [
      [`customer/${today}`, `customer/${hashed(email)}`,
        { email, perks: [{ type: PERK }] }],
      [`cart/${today}`, `cart/${hashed(email)}`,
        { lines: [{ sku: "egg" }] }],
      [`support/${today}/m1`, `support/${hashed(email)}/m1`, { text: "hi" }],
    ]);
    const seed = async (stores) => {
      for (const [from, , value] of moves) {
        await stores.customers.set(from, value);
      }
    };
    const masks = [SPACED, RAW].map(maskEmail);
    const moveLines = () => lines.filter((l) => masks.some((m) => l
      .includes(m)));

    // A dry run finds every record and moves nothing, logging nothing.
    const stores = testStores();

    await seed(stores);

    const dry = await rekeyRecords(stores, { apply: false, by: "cli" });
    const reported = JSON.stringify(dry);

    for (const [from, to, value] of moves) {
      assert.ok(reported.includes(JSON.stringify(from).slice(1, -1)),
        `the dry run reports ${from}`);
      assert.deepEqual(await stores.customers.get(from), value,
        `dry run: ${from} is still where it was`);
      assert.equal(await stores.customers.get(to), null,
        `dry run: nothing is written to ${to}`);
    }
    assert.equal(moveLines().length, 0, "a dry run logs no move");

    // Applied, each record goes to its hashed key, one masked log line
    // each.
    await rekeyRecords(stores, { apply: true, by: "cli" });

    for (const [from, to, value] of moves) {
      assert.deepEqual(await stores.customers.get(to), value,
        `${to} holds what ${from} held`);
      assert.equal(await stores.customers.get(from), null,
        `${from} is gone`);
    }
    assert.equal(moveLines().length, moves.length,
      "one log line per move");
    for (const l of moveLines()) {
      assert.ok(![PLUS, SPACED, RAW].some((a) => l.includes(a)),
        `the log line masks the address: ${l}`);
    }

    // A record already at the hashed key is never overwritten.
    const taken = testStores();
    const takenKey = `customer/${hashed(PLUS)}`;
    const kept = { email: PLUS, perks: [] };

    await seed(taken);
    await taken.customers.set(takenKey, kept);
    lines.length = 0;

    const refused = await rekeyRecords(taken, { apply: true, by: "cli" });

    assert.deepEqual(await taken.customers.get(takenKey), kept,
      "the record at the hashed key is kept");
    assert.deepEqual(await taken.customers.get(`customer/${SPACED}`),
      moves[0][2], "the old record is left where it was");
    assert.ok(JSON.stringify(refused.refused).includes(`customer/${SPACED}`),
      "the step reports the move it refused");
    assert.ok(!lines.some((l) => l.includes(masks[0])
      && l.includes("customer/")),
    "a refused move logs no move");
  });
});
