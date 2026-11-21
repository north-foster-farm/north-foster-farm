// Criteria tests for #718 (Invite links: sign up with your own email
// and get your pricing), one per "Done when" box marked (test), each
// named for its box. Written before the code, by a test agent; the
// implementer turns the file on by renaming it to invites.test.mjs.
//
// The seam these tests assume, modeled on the group sign-up page
// (#495, lib/join.mjs) and the perks (#514, lib/perks.mjs):
//
// - netlify/functions/lib/invites.mjs
//     addInvite(stores, perk, { end, note, square, by, now, env })
//       -> { id, url }, url = `${siteUrl(env)}/invite/?t=<token>`.
//       `end` is the perk's last day, as `perks add --end`; the invite
//       itself lasts 14 days from `now`. An unknown perk is refused.
//     listInvites(stores, { now }) -> [{ id, perk, state, ... }],
//       state "open", "used", "expired" or "revoked".
//     revokeInvite(stores, id, { by, now }); an unknown id throws.
// - netlify/functions/invite.mjs, handle(req, { stores, env, now, ip,
//   mail }), as join.mjs:
//     POST /api/invite/check    { token }  200 { ok: true, ... }
//     POST /api/invite/request  { token, email }  200 { ok: true },
//       a sign-in link mailed to that address (lib/auth requestLink)
//     a dead invite (used, expired, revoked, unknown): 404
//       { ok: false, message }, the one plain message, nothing mailed
// - GET /api/auth/verify?token=<that link's token>, auth.mjs's
//   handle(req, { stores, env, now, fetchImpl }): signs in, then
//   attaches the perk to the account if the invite is still open at
//   that moment, and uses the invite up. With `square`, it first reads
//   that Square customer (GET /v2/customers/<id>, the recorded
//   customer-get and customer-get-no-email). Only when the customer has
//   no email address, or already has the account's in any case, does it
//   put the account's address there (PUT /v2/customers/<id>, the
//   recorded customer-update) and keep the id on the customer record as
//   `squareCustomerId`. Otherwise it writes nothing to Square, keeps no
//   id, still grants the perk, and logs `invite.square-skipped` with
//   both addresses masked (security on #733, 2026-11-21).
// - An invite whose perk `end` has passed is dead, as an expired one is
//   (qa on #733, 2026-11-21).
// - bin/nff invite add <perk> [--end YYYY-MM-DD] [--note "..."]
//   [--square <id>] prints the link; `invite list`; `invite revoke
//   <id>`.
// - Log lines: `event` starting "invite." for making, using and
//   revoking, each with `_time`, `by` and the target masked as
//   lib/mask.mjs masks an address. Expiry is a date, not a write, so
//   no line is required for it; any line written is held to the same
//   rules.
//
// Each module is imported inside its test, so on a branch without
// invites every box fails on its own, by name.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { handle as ordersHandle } from "../netlify/functions/orders.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import { perkTypes } from "../netlify/functions/lib/perks.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { body, serve } from "./recorded.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const invites = () => import("../netlify/functions/lib/invites.mjs");
const inviteFn = () => import("../netlify/functions/invite.mjs");

const now = instant("2026-10-06", 9, 0, "America/New_York");
const DAY = 24 * 60 * 60_000;
const at = (ms) => new Date(now.getTime() + ms);
const ENV = { URL: "https://x" };
const SANDBOX = {
  ...ENV, SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOCATION_ID_1",
};
const PAT = "pat@example.com";
const SAM = "sam@example.com";
const NOTE = "Lives past the red barn on Route 6";
const SQUARE_ID = "CUSTOMER_ID_1";

const quiet = (t) => {
  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, () => {});
  }
};

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

const tokenOf = (url) => new URL(url).searchParams.get("t");

const post = (path, body) => new Request(`https://x${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json", "sec-fetch-site": "same-origin",
  },
  body: JSON.stringify(body),
});

// The invite page's two calls. -> { status, data, link } where `link`
// is the token of the sign-in link mailed, or null when none was.
const check = async (stores, token, { when = now } = {}) => {
  const { handle } = await inviteFn();
  const res = await handle(post("/api/invite/check", { token }), {
    stores, env: ENV, now: when, ip: "",
  });

  return { status: res.status, data: await res.json() };
};

const ask = async (stores, token, email, { when = now } = {}) => {
  const { handle } = await inviteFn();
  const sent = [];
  const res = await handle(post("/api/invite/request", { token, email }), {
    stores, env: ENV, now: when, ip: "",
    mail: async (m) => {
      sent.push(m);

      return { id: "m1", driver: "test" };
    },
  });
  const found = JSON.stringify(sent)
    .match(/\/api\/auth\/verify\?token=([A-Za-z0-9_-]+)/);

  return {
    status: res.status, data: await res.json(), sent,
    link: found ? found[1] : null,
  };
};

// Following the mailed link: the usual sign-in.
const follow = (stores, link, { when = now, env = ENV, fetchImpl } = {}) =>
  authHandle(new Request(`https://x/api/auth/verify?token=${link}`), {
    stores, env, now: when, ...(fetchImpl ? { fetchImpl } : {}),
  });

// Asks and follows. -> the perk types the account holds after.
const signUp = async (stores, url, email, options = {}) => {
  const asked = await ask(stores, tokenOf(url), email, options);

  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.ok(asked.link, "a sign-in link was mailed");

  const res = await follow(stores, asked.link, options);

  assert.equal(res.status, 302, "signed in");

  return perkTypes(await getCustomer(stores, email), options.when || now);
};

const holds = async (stores, email, when = now) => {
  const c = await getCustomer(stores, email);

  return c ? perkTypes(c, when) : [];
};

const stateOf = async (stores, id, when = now) => {
  const { listInvites } = await invites();
  const row = (await listInvites(stores, { now: when }))
    .find((r) => r.id === id);

  return row && row.state;
};

const pat = () => ({
  email: PAT, firstName: "Pat", lastName: "Example", name: "Pat Example",
  phone: "4015550100", avatar: null, discountGroup: null, address: null,
  marketing: false, marketingAt: null, createdAt: "2026-01-02T12:00:00.000Z",
});

// The CLI from a temporary root of links to this checkout, with no env
// file and no Netlify link, as test/context-guard.test.mjs runs it:
// development, memory stores, nothing real read or reached.
const LEFT_OUT = new Set([".git", ".ignored", ".netlify"]);

const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "nff-718-"));
  const repo = join(dir, "repo");
  const stubs = join(dir, "stubs");

  mkdirSync(repo);
  mkdirSync(stubs);
  for (const name of readdirSync(root)) {
    if (LEFT_OUT.has(name) || name.startsWith(".env")) continue;
    symlinkSync(join(root, name), join(repo, name));
  }
  // Never the Keychain.
  writeFileSync(join(stubs, "security"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(stubs, "security"), 0o755);

  return { dir, repo, stubs };
};

const runNff = (where, args) => spawnSync(process.execPath, [
  "--preserve-symlinks", "--preserve-symlinks-main",
  join(where.repo, "bin", "nff"), ...args,
], {
  cwd: where.repo,
  encoding: "utf8",
  timeout: 60_000,
  env: {
    PATH: `${where.stubs}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: where.dir,
    TZ: "America/New_York",
  },
});

const both = (r) => `${r.stdout}\n${r.stderr}`;

describe("invite links (#718)", () => {
  it("bin/nff invite add makes a single-use invite for a perk and prints "
    + "its link; invite list shows it, and invite revoke ends it",
  async (t) => {
    const where = makeRoot();

    try {
      const added = runNff(where, ["invite", "add", "friends", "--end",
        "2027-12-31", "--note", NOTE, "--yes"]);

      assert.equal(added.status, 0, both(added));
      assert.match(added.stdout,
        /https?:\/\/\S+\/invite\/\?t=[A-Za-z0-9_-]{20,}/, "prints the link");

      const listed = runNff(where, ["invite", "list"]);

      assert.equal(listed.status, 0, both(listed));

      const revoked = runNff(where, ["invite", "revoke", "no-such-invite"]);

      assert.notEqual(revoked.status, 0, "an unknown id is refused");
      assert.doesNotMatch(revoked.stderr, /^Usage:/m, "a known command");
    } finally {
      rmSync(where.dir, { recursive: true, force: true });
    }

    // The same, in one process, so list and revoke see what add made.
    quiet(t);

    const { addInvite, revokeInvite } = await invites();
    const stores = testStores();

    await assert.rejects(addInvite(stores, "free-eggs", {
      by: "james", now, env: ENV,
    }), /free-eggs/, "an unknown perk is refused");

    const made = await addInvite(stores, "friends", {
      note: NOTE, by: "james", now, env: ENV,
    });

    assert.match(made.url, /^https:\/\/x\/invite\/\?t=[A-Za-z0-9_-]{20,}$/);
    assert.equal(typeof made.id, "string");
    assert.equal(await stateOf(stores, made.id), "open");
    assert.equal((await check(stores, tokenOf(made.url))).status, 200);

    await revokeInvite(stores, made.id, { by: "james", now });

    assert.equal(await stateOf(stores, made.id), "revoked");
    assert.equal((await check(stores, tokenOf(made.url))).status, 404,
      "the link is dead");
    await assert.rejects(revokeInvite(stores, "no-such-invite", {
      by: "james", now,
    }));
  });

  it("following the link and signing up with any email address attaches "
    + "the perk to that account, new or existing, and the link then works "
    + "for no one else", async (t) => {
    quiet(t);

    const { addInvite } = await invites();

    // An existing account: the perk joins it, the record keeps the rest.
    {
      const stores = testStores();

      await saveCustomer(stores, pat());

      const made = await addInvite(stores, "free-delivery", {
        end: "2027-06-30", by: "james", now, env: ENV,
      });

      assert.deepEqual(await signUp(stores, made.url, PAT),
        ["free-delivery"]);

      const saved = await getCustomer(stores, PAT);

      assert.equal(saved.firstName, "Pat", "the rest of the record stays");
      assert.equal(saved.perks.length, 1);
      assert.equal(saved.perks[0].end, "2027-06-30", "the invite's --end");
      assert.equal(await stateOf(stores, made.id), "used");

      // Anyone after: told the link is dead, mailed nothing.
      const late = await ask(stores, tokenOf(made.url), SAM);

      assert.equal(late.status, 404);
      assert.equal(late.sent.length, 0, "no link mailed");
      assert.equal((await check(stores, tokenOf(made.url))).status, 404);
      assert.deepEqual(await holds(stores, SAM), []);
    }

    // A new address: the account is made, with the perk on it.
    {
      const stores = testStores();
      const made = await addInvite(stores, "friends", {
        by: "james", now, env: ENV,
      });

      assert.equal(await getCustomer(stores, SAM), null);
      assert.deepEqual(await signUp(stores, made.url, SAM), ["friends"]);
    }

    // Two people ask before either follows: the first to follow gets
    // it, and the second link signs in with no perk.
    {
      const stores = testStores();
      const made = await addInvite(stores, "friends", {
        by: "james", now, env: ENV,
      });
      const first = await ask(stores, tokenOf(made.url), PAT);
      const second = await ask(stores, tokenOf(made.url), SAM);

      assert.ok(first.link && second.link, "both were mailed a link");
      assert.equal((await follow(stores, first.link)).status, 302);
      assert.equal((await follow(stores, second.link)).status, 302,
        "the second still signs in");
      assert.deepEqual(await holds(stores, PAT), ["friends"]);
      assert.deepEqual(await holds(stores, SAM), [], "the second gets none");
    }
  });

  it("a link past its 14 days, used or revoked, grants nothing and shows "
    + "a plain message", async (t) => {
    quiet(t);

    const { addInvite, revokeInvite } = await invites();
    const stores = testStores();
    const make = () => addInvite(stores, "friends", {
      by: "james", now, env: ENV,
    });

    // 14 days: open the hour before, dead the minute after.
    const aged = await make();
    const lastHour = at(14 * DAY - 60 * 60_000);
    const past = at(14 * DAY + 60_000);

    assert.equal((await check(stores, tokenOf(aged.url), {
      when: lastHour,
    })).status, 200, "open on its last day");
    assert.equal(await stateOf(stores, aged.id, past), "expired");

    const used = await make();

    await signUp(stores, used.url, "first@example.com");

    const revoked = await make();

    await revokeInvite(stores, revoked.id, { by: "james", now });

    const messages = [];

    for (const [what, url, when] of [
      ["past 14 days", aged.url, past],
      ["used", used.url, now],
      ["revoked", revoked.url, now],
      ["unknown", "https://x/invite/?t=nonesuchnonesuchnonesuch0", now],
    ]) {
      const token = tokenOf(url);
      const looked = await check(stores, token, { when });
      const asked = await ask(stores, token, SAM, { when });

      assert.equal(looked.status, 404, what);
      assert.equal(looked.data.ok, false, what);
      assert.equal(asked.status, 404, what);
      assert.equal(asked.sent.length, 0, `${what}: no link mailed`);
      assert.equal(asked.data.message, looked.data.message, what);
      assert.ok(!looked.data.message.includes(token), `${what}: no token`);
      messages.push(looked.data.message);
    }

    const [message] = messages;

    assert.equal(new Set(messages).size, 1, "the one message for each");
    assert.equal(typeof message, "string");
    assert.match(message, /^[A-Z][^;—]*\.$/,
      "a plain sentence, no semicolon or em dash (#400)");
    assert.deepEqual(await holds(stores, SAM, past), [], "nothing granted");

    // An invite that dies between the ask and the follow grants nothing:
    // revoked, or past its 14 days by the time the link is followed.
    const revokedLater = await make();
    const early = await ask(stores, tokenOf(revokedLater.url), PAT);

    await revokeInvite(stores, revokedLater.id, { by: "james", now });
    await follow(stores, early.link);
    assert.deepEqual(await holds(stores, PAT), [], "revoked after the ask");

    const late = await make();
    const lastMinutes = at(14 * DAY - 5 * 60_000);
    const justPast = at(14 * DAY + 5 * 60_000);
    const asked = await ask(stores, tokenOf(late.url), "late@example.com", {
      when: lastMinutes,
    });

    assert.ok(asked.link, "asked in time");
    await follow(stores, asked.link, { when: justPast });
    assert.deepEqual(await holds(stores, "late@example.com", justPast), [],
      "followed after its 14 days");
  });

  it("with --square, the account is linked to that Square customer when "
    + "its email address is empty or already the follower's, and otherwise "
    + "left alone with invite.square-skipped logged", async (t) => {
    const lines = capture(t);
    const { addInvite } = await invites();
    // The Square customer as the sandbox answered for it (test/fixtures/
    // square/customer-get.json and customer-get-no-email.json, sandbox,
    // 2026-11-21): one with an email address, one without.
    const ON_FILE = body("square", "customer-get").customer.email_address;

    assert.ok(ON_FILE, "the recording has an address");
    assert.equal(body("square", "customer-get-no-email").customer
      .email_address, undefined, "the recording has none");

    // Follows an invite naming the customer in `fixture` as `typed`.
    // Square answers from `answers` in turn, and every request is held
    // to the one it was recorded from.
    const follower = async (fixture, typed, answers) => {
      const stores = testStores();
      const id = body("square", fixture).customer.id;
      const made = await addInvite(stores, "friends", {
        square: id, by: "james", now, env: SANDBOX,
      });
      const net = serve("square", ...answers);
      const sent = [];
      const fetchImpl = async (url, init) => {
        sent.push({
          method: init.method || "GET", path: new URL(url).pathname,
          body: init.body ? JSON.parse(init.body) : null,
        });

        return net.impl(url, init);
      };
      const mark = lines.length;
      const perks = await signUp(stores, made.url, typed, {
        env: SANDBOX, fetchImpl,
      });
      const logged = lines.slice(mark)
        .filter((l) => /"event":"invite\./.test(l));

      assert.deepEqual(net.problems, [], typed);
      assert.deepEqual(net.left(), [], `${typed}: every answer asked for`);
      assert.equal(sent[0].method, "GET", `${typed}: Square read first`);
      assert.equal(sent[0].path, `/v2/customers/${id}`);

      return {
        id, perks, sent, logged,
        account: await getCustomer(stores, typed),
      };
    };

    const linked = (r, typed, before) => {
      assert.deepEqual(r.perks, ["friends"], `${typed}: the perk`);
      assert.equal(r.sent.length, 2, `${typed}: a read, then one write`);
      assert.equal(r.sent[1].method, "PUT");
      assert.equal(r.sent[1].path, `/v2/customers/${r.id}`);
      assert.deepEqual(Object.keys(r.sent[1].body), ["email_address"]);
      assert.equal(r.sent[1].body.email_address, typed.toLowerCase(),
        `${typed}: the account's address on that Square customer`);
      assert.equal(r.account.squareCustomerId, r.id, `${typed}: linked`);

      const write = r.logged.filter((l) => l.includes(r.id)
        && l.includes(maskEmail(typed)));

      assert.ok(write.length,
        `${typed}: the write logged, naming the customer, address masked`);
      if (before) {
        assert.ok(write.some((l) => l.includes(maskEmail(before))),
          `${typed}: the address before, masked`);
      }
    };

    // Empty: the customer known only to Square gets the address.
    linked(await follower("customer-get-no-email", PAT,
      ["customer-get-no-email", "customer-update"]), PAT, null);

    // Already the follower's, typed in another case: written, linked.
    const shouting = ON_FILE.toUpperCase();

    assert.notEqual(shouting, ON_FILE);
    linked(await follower("customer-get", shouting,
      ["customer-get", "customer-update"]), shouting, ON_FILE);

    // Someone else's: the forwarded link writes nothing to Square, keeps
    // no id, and still grants the perk.
    const other = await follower("customer-get", PAT, ["customer-get"]);

    assert.deepEqual(other.perks, ["friends"], "the perk is still granted");
    assert.equal(other.sent.length, 1, "only the read; no write to Square");
    assert.equal(other.account.squareCustomerId, undefined, "not linked");

    const skipped = other.logged.map((l) => JSON.parse(l))
      .filter((l) => l.event === "invite.square-skipped");

    assert.equal(skipped.length, 1, "invite.square-skipped logged");

    const [line] = skipped.map((l) => JSON.stringify(l));

    assert.ok(line.includes(maskEmail(PAT)), "the follower's, masked");
    assert.ok(line.includes(maskEmail(ON_FILE)), "Square's, masked");
    for (const full of [PAT, ON_FILE, shouting]) {
      assert.ok(!lines.some((l) => l.includes(full)),
        `no line has ${full} in full`);
    }
  });

  it("an invite whose perk end date has passed is dead like an expired "
    + "one: it grants nothing and shows the plain message, and changes "
    + "nothing in Square", async (t) => {
    quiet(t);

    const { addInvite } = await invites();
    const stores = testStores();
    const zone = "America/New_York";
    // The perk's last day is 2026-10-10, well inside the invite's 14 days.
    const lastDay = instant("2026-10-10", 20, 0, zone);
    const after = instant("2026-10-11", 9, 0, zone);
    const make = () => addInvite(stores, "friends", {
      end: "2026-10-10", square: SQUARE_ID, by: "james", now, env: SANDBOX,
    });
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push(`${init.method || "GET"} ${new URL(url).pathname}`);

      return new Response("{}", { status: 500 });
    };

    // The message an invite past its 14 days shows.
    const aged = await addInvite(stores, "friends", {
      by: "james", now, env: ENV,
    });
    const expired = await check(stores, tokenOf(aged.url), {
      when: at(15 * DAY),
    });

    assert.equal(expired.status, 404);

    const ended = await make();

    assert.equal((await check(stores, tokenOf(ended.url), {
      when: lastDay,
    })).status, 200, "open on the perk's last day");

    const looked = await check(stores, tokenOf(ended.url), { when: after });
    const asked = await ask(stores, tokenOf(ended.url), SAM, { when: after });

    assert.equal(looked.status, 404, "dead once the perk's end has passed");
    assert.equal(looked.data.ok, false);
    assert.equal(looked.data.message, expired.data.message,
      "the plain message an expired invite shows");
    assert.equal(asked.status, 404);
    assert.equal(asked.data.message, expired.data.message);
    assert.equal(asked.sent.length, 0, "no link mailed");
    assert.notEqual(await stateOf(stores, ended.id, after), "open",
      "not listed as open");

    // Asked for on the perk's last day, followed the day after.
    const late = await make();
    const early = await ask(stores, tokenOf(late.url), PAT, {
      when: lastDay,
    });

    assert.ok(early.link, "asked in time");
    await follow(stores, early.link, { when: after, env: SANDBOX, fetchImpl });

    assert.deepEqual(await holds(stores, PAT, lastDay), [],
      "nothing granted, not even for the day it was asked");
    assert.deepEqual(await holds(stores, SAM, lastDay), []);
    assert.equal((await getCustomer(stores, PAT) || {}).squareCustomerId,
      undefined, "not linked");
    assert.deepEqual(sent, [], "nothing asked of or sent to Square");
  });

  // #521's tests stand as they are (test/perk-checkout.test.mjs,
  // e2e/typed-address.spec.mjs). This holds the same for a perk an
  // invite gave, and for the invite page itself.
  it("typing a perk holder's address while signed out still changes "
    + "nothing on the page or in the API response", async (t) => {
    quiet(t);

    const { addInvite } = await invites();
    const SKU = "NFF-CHK-WHL-35-39";

    // Pat holds friends through an invite, and is signed out.
    const holder = async () => {
      const stores = testStores();
      const made = await addInvite(stores, "friends", {
        by: "james", now, env: ENV,
      });

      assert.deepEqual(await signUp(stores, made.url, PAT), ["friends"]);

      return stores;
    };
    const square = () => ({
      createOrder: async () => ({ squareOrderId: "SQO", customerId: "CUST" }),
      createPayment: async () => ({
        squarePaymentId: "PAY", status: "COMPLETED", receiptUrl: null,
        brand: "VISA", last4: "4242", wallet: null,
      }),
      payZeroOrder: async (id) => ({ squareOrderId: id }),
      cancelOrder: async (id) => ({ id, cancelled: true }),
      findPaid: async () => null,
    });
    const order = (email) => ({
      idempotencyKey: "5b1d0f3e-2c4a-4e6b-9a8d-7c6b5a4f3e2d",
      attempt: 1,
      customer: {
        firstName: "Pat", lastName: "Example", email,
        phone: "401-555-0100", contact: "call",
      },
      lines: [{ sku: SKU, qty: 2 }],
      fulfilment: {
        method: "delivery",
        date: "2026-10-08",
        delivery: {
          address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch",
        },
      },
      claimedTotal: 6000,
      payment: { method: "card", sourceId: "cnon:tok" },
    });
    const answer = async (email) => {
      const stores = await holder();
      const res = await ordersHandle(new Request("http://x/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(order(email)),
      }), { stores, square: square(), now, sleep: async () => {} });
      const text = await res.text();
      const { orderId } = JSON.parse(text);

      return {
        status: res.status,
        body: JSON.parse(text.replaceAll(orderId || "\0", "ID")
          .replaceAll(email, "EMAIL")),
      };
    };

    const theirs = await answer(PAT);
    const anyone = await answer("someone.else@example.com");

    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.deepEqual(theirs, anyone);
    assert.equal(theirs.body.totals.total, 6000);
    assert.equal(theirs.body.totals.perks, undefined);

    // On the invite page, a perk holder's address typed by someone else
    // is answered as any address is, and changes nothing of theirs
    // until the link mailed to it is followed.
    const stores = await holder();
    const before = await getCustomer(stores, PAT);
    const next = await addInvite(stores, "free-delivery", {
      by: "james", now, env: ENV,
    });
    const typed = await ask(stores, tokenOf(next.url), PAT);
    const stranger = await ask(stores, tokenOf(next.url),
      "someone.else@example.com");

    assert.equal(typed.status, stranger.status);
    assert.deepEqual(typed.data, stranger.data);
    assert.deepEqual(await getCustomer(stores, PAT), before,
      "the holder's record is untouched");
  });

  it("each invite change is logged without the note, the token or a full "
    + "email address", async (t) => {
    const lines = capture(t);
    const { addInvite, listInvites, revokeInvite } = await invites();
    const stores = testStores();
    const invite = (when) => lines
      .slice(when)
      .filter((l) => /"event":"invite\./.test(l))
      .map((l) => JSON.parse(l));

    let mark = lines.length;
    const made = await addInvite(stores, "friends", {
      note: NOTE, square: SQUARE_ID, end: "2027-12-31", by: "james", now,
      env: ENV,
    });
    const token = tokenOf(made.url);

    assert.ok(invite(mark).length, "making is logged");

    // Using it, with the Square link: a customer with no address
    // (recorded customer-get-no-email), then the write (customer-update).
    mark = lines.length;
    await signUp(stores, made.url, PAT, {
      env: SANDBOX,
      fetchImpl: serve("square", "customer-get-no-email", "customer-update")
        .impl,
    });

    const use = invite(mark);

    assert.ok(use.length, "using is logged");
    assert.ok(use.some((l) => JSON.stringify(l).includes(maskEmail(PAT))),
      "the account it went to, masked");

    mark = lines.length;

    const other = await addInvite(stores, "free-delivery", {
      note: NOTE, by: "james", now, env: ENV,
    });

    await revokeInvite(stores, other.id, { by: "james", now });
    assert.ok(invite(mark).some((l) => JSON.stringify(l).includes(other.id)),
      "revoking is logged, naming the invite");

    // An expired one tried and listed: logged or not, held the same.
    const aged = await addInvite(stores, "friends", {
      note: NOTE, by: "james", now, env: ENV,
    });

    await ask(stores, tokenOf(aged.url), SAM, { when: at(15 * DAY) });
    await listInvites(stores, { now: at(15 * DAY) });

    const all = invite(0);

    for (const l of all) {
      assert.ok(l._time, `${l.event}: the time`);
      assert.ok(typeof l.by === "string" && l.by, `${l.event}: who acted`);
    }

    const secrets = [
      ["the note", NOTE], ["part of the note", "red barn"],
      ["a token", token], ["a token", tokenOf(other.url)],
      ["a token", tokenOf(aged.url)],
      ["a full address", PAT], ["a full address", SAM],
    ];

    for (const [what, value] of secrets) {
      assert.ok(!lines.some((l) => l.includes(value)), `no line has ${what}`);
    }
  });
});
