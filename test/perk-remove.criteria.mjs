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
// lib/store.mjs to naming that same stored key on both routes, and a
// plain key unchanged on both (corrected 2026-11-21: it held both
// routes to percent-encoding every segment, which the API route
// rejects for plain addresses). It spies on fetch and throws before
// any answer, so no response is faked.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { showCustomer } from "../netlify/functions/lib/admin.mjs";
import { addInvite } from "../netlify/functions/lib/invites.mjs";
import {
  listPerks, removePerk,
} from "../netlify/functions/lib/perks.mjs";
import {
  customerKey,
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

  it("The CLI's route and the functions' route name the same stored "
    + "key for any valid address, a \"+\" included, while plain "
    + "addresses keep resolving on both (test)", async (t) => {
    quiet(t);

    // What the real Blobs server answered on staging, read-only,
    // 2026-11-21 (#758): the functions' edge route reads a raw "+" in
    // the path as a space, so the record the invite sign-in made for
    // james+dog@... is stored as "james dog@...". The CLI's API route
    // finds that record only by "%20" (a raw "+" and "%2B" miss), and
    // finds a plain address only with "@" raw ("%40" misses). So for
    // a+b@... both routes must name the stored key "customer/a b@...":
    // the edge route sends the key raw, the API route sends the "+" as
    // "%20" and the "@" raw. A plain key goes out unchanged on both.
    //
    // "%", "#" and "?" are left out on purpose: how the real server
    // reads them is unproven, and proving it needs a staging write,
    // which nobody does.
    const SITE = "site-id-1";
    const CONTEXT = "branch-deploy";
    const store = storeName("customers", { SITE_CONTEXT: CONTEXT });
    const PLAIN = "customer/pat@example.com";
    // The path each route must send for a key, by route.
    const cases = [
      { key: customerKey(PLUS), cli: "customer/pat%20dog@example.com",
        functions: "customer/pat+dog@example.com" },
      { key: PLAIN, cli: PLAIN, functions: PLAIN },
    ];

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
        }
      }
    }
  });
});
