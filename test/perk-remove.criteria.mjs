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
// reads a raw "+" in the path as a space. The third test holds
// lib/store.mjs to percent-encoding each key segment on both routes
// (James, 2026-11-21, after two other readings were tried and
// dropped the same evening). It spies on fetch and throws before any
// answer, so no response is faked. The fourth holds every address a
// function or the CLI takes to one decode, cleaning and validation,
// and the fifth the CLI step that moves a record from its decoded key
// to its exact one.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
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
import { creditKey } from "../netlify/functions/lib/credit.mjs";
import {
  cartKey, customerKey,
} from "../netlify/functions/lib/records.mjs";
import {
  maskKey, storeName, stores as makeStores, testStores,
} from "../netlify/functions/lib/store.mjs";

const now = instant("2026-11-21", 9, 0, "America/New_York");
const ENV = { URL: "https://x" };
const PERK = "free-delivery";

// A plus address and a mixed-case one, as the person types them.
const PLUS = "pat+dog@example.com";
const MIXED = "Sam.Example@Example.COM";

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

  it("Every key segment is fully URL-encoded in the request path on "
    + "both the CLI's route and the functions' route (\"+\" as %2B, "
    + "\"@\" as %40), and every record is stored and found under its "
    + "address exactly, plain addresses included (test)", async (t) => {
    quiet(t);

    // James, 2026-11-21: "any strings passed as query string args
    // should be url encoded for requests like this". Each "/" segment
    // goes through encodeURIComponent, the "/" between them kept, on
    // both routes: "+" as %2B, "@" as %40, and "%", "#" and "?", which
    // a raw path reads as an escape, a fragment and a query. Where the
    // real server misses an encoded key (staging missed "%40" on the
    // API route), the route below the store is to be fixed, never the
    // encoding skipped (#758).
    const SITE = "site-id-1";
    const CONTEXT = "branch-deploy";
    const store = storeName("customers", { SITE_CONTEXT: CONTEXT });
    const encoded = (key) => key.split("/").map(encodeURIComponent)
      .join("/");
    const keys = [
      customerKey(PLUS), "customer/pat@example.com",
      "customer/pat dog@example.com", "customer/50%off@example.com",
      "customer/a#b@example.com", "customer/a?b@example.com",
    ];
    // The path each route must send for a key, by route.
    const cases = keys.map((key) => ({
      key, cli: encoded(key), functions: encoded(key),
    }));

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
      const { customers } = make();

      for (const { key, [route]: path } of cases) {
        for (const [op, call] of [
          ["get", () => customers.get(key)],
          ["set", () => customers.set(key, { email: "x" })],
        ]) {
          const url = await firstUrl(call);
          const where = `${route} ${op} ${JSON.stringify(key)}`;

          // The client names the store `site:<name>` in the path.
          assert.ok(url.pathname.endsWith(`${store}/${path}`),
            `${where}: path ${url.pathname} ends ${store}/${path}`);
          assert.equal(url.hash, "", `${where}: no part of the key is a `
            + "fragment");
          assert.ok(!url.search.includes(key.split("/").pop()),
            `${where}: no part of the key is a query`);
        }
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
    // record the sign-in makes is under its exact key.
    for (const typed of ["pat%2Bdog%40example.com",
      "  Pat+Dog@Example.COM "]) {
      const stores = testStores();

      await signUpByInvite(stores, typed);

      const record = await stores.customers.get(customerKey(PLUS));

      assert.equal(record && record.email, PLUS,
        `${JSON.stringify(typed)}: stored as ${customerKey(PLUS)}`);

      const keys = (await stores.customers.list("customer/"))
        .map((e) => e.key);

      assert.deepEqual(keys, [customerKey(PLUS)],
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

  it("Records now stored under a decoded key (a space for a \"+\") are "
    + "moved to their exact key by a CLI step, dry run first, one log "
    + "line per move (test)", async (t) => {
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

    // The record as staging holds it: under the decoded key, its own
    // email exact, with a cart, credit and a support message keyed by
    // the same decoded address.
    const DECODED = "pat dog@example.com";
    const moves = [
      [`customer/${DECODED}`, customerKey(PLUS),
        { email: PLUS, perks: [{ type: PERK }] }],
      [`cart/${DECODED}`, cartKey(PLUS), { lines: [{ sku: "egg" }] }],
      [`credit/${DECODED}`, creditKey(PLUS), { cents: 500 }],
      [`support/${DECODED}/m1`, `support/${PLUS}/m1`, { text: "hi" }],
    ];
    const seed = async (stores) => {
      for (const [from, , value] of moves) {
        await stores.customers.set(from, value);
      }
    };
    const masked = maskKey(customerKey(PLUS)).split("/").pop();
    const moveLines = () => lines.filter((l) => l.includes(masked));

    // A dry run finds the record and moves nothing, logging nothing.
    const stores = testStores();

    await seed(stores);

    const dry = await rekeyRecords(stores, { apply: false, by: "cli" });

    assert.match(JSON.stringify(dry), /customer\/pat/,
      "the dry run reports the customer record it would move");
    for (const [from, to, value] of moves) {
      assert.deepEqual(await stores.customers.get(from), value,
        `dry run: ${from} is still where it was`);
      assert.equal(await stores.customers.get(to), null,
        `dry run: nothing is written to ${to}`);
    }
    assert.equal(moveLines().length, 0, "a dry run logs no move");

    // Applied, each record goes to its exact key, one log line each.
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
      assert.ok(!l.includes(PLUS) && !l.includes(DECODED),
        `the log line masks the address: ${l}`);
    }

    // A record already at the exact key is never overwritten.
    const taken = testStores();
    const kept = { email: PLUS, perks: [] };

    await seed(taken);
    await taken.customers.set(customerKey(PLUS), kept);
    lines.length = 0;

    const refused = await rekeyRecords(taken, { apply: true, by: "cli" });

    assert.deepEqual(await taken.customers.get(customerKey(PLUS)), kept,
      "the record at the exact key is kept");
    assert.deepEqual(await taken.customers.get(`customer/${DECODED}`),
      moves[0][2], "the decoded record is left where it was");
    assert.match(JSON.stringify(refused.refused), /customer\/pat/,
      "the step reports the move it refused");
    assert.ok(!lines.some((l) => l.includes(maskKey(customerKey(PLUS)))),
      "a refused move logs no move");
  });
});
