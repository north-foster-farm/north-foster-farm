// The implementer's own tests for #718's invite links, for what the
// criteria tests (test/invites.test.mjs) don't reach: the refusals,
// a Square link that fails, an invite used on a perk already held, the
// CLI's list, and the invite page's own slot for its token.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import {
  dropToken, takeToken,
} from "../assets/scripts/join/token.mjs";
import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { handle as inviteHandle } from "../netlify/functions/invite.mjs";
import { requestLink } from "../netlify/functions/lib/auth.mjs";
import {
  addInvite, checkInvite, finishInvite, linkRecord, listInvites,
  revokeInvite,
} from "../netlify/functions/lib/invites.mjs";
import { addPerk } from "../netlify/functions/lib/perks.mjs";
import { getCustomer } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { inviteCommand } from "../bin/invite.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const ENV = { URL: "https://x" };
const PAT = "pat@example.com";

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

const post = (path, body) => new Request(`https://x${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json", "sec-fetch-site": "same-origin",
  },
  body: JSON.stringify(body),
});

const tokenOf = (url) => new URL(url).searchParams.get("t");

// The sign-in link's record for an invite, as the invite page mails it.
const linkFor = async (stores, made, email) => {
  const [invite] = (await listInvites(stores, { now }))
    .filter((r) => r.id === made.id);
  const sent = await requestLink(stores, { email, next: "/account/" }, {
    now, env: ENV, send: false, invite: linkRecord(invite),
  });

  return new URL(sent.url).searchParams.get("token");
};

describe("invite links, beyond the criteria (#718)", () => {
  it("refuses the family perk without --owner, a past --end and a bad "
    + "Square id", async (t) => {
    quiet(t);

    const stores = testStores();

    await assert.rejects(addInvite(stores, "family", { now, env: ENV }),
      /--owner/);
    await assert.rejects(addInvite(stores, "friends", {
      end: "2026-10-05", now, env: ENV,
    }), /past/);
    await assert.rejects(addInvite(stores, "friends", {
      end: "next week", now, env: ENV,
    }), /YYYY-MM-DD/);
    await assert.rejects(addInvite(stores, "friends", {
      square: "a/b", now, env: ENV,
    }), /Square/);

    const made = await addInvite(stores, "family", {
      owner: true, now, env: ENV,
    });

    assert.equal((await listInvites(stores, { now }))[0].id, made.id);
  });

  it("refuses to revoke an invite twice, or one already used",
    async (t) => {
      quiet(t);

      const stores = testStores();
      const a = await addInvite(stores, "friends", { now, env: ENV });

      await revokeInvite(stores, a.id, { now });
      await assert.rejects(revokeInvite(stores, a.id, { now }), /revoked/);

      const b = await addInvite(stores, "friends", { now, env: ENV });
      const [invite] = (await listInvites(stores, { now }))
        .filter((r) => r.id === b.id);

      await finishInvite(stores, PAT, linkRecord(invite), { now, env: ENV });
      await assert.rejects(revokeInvite(stores, b.id, { now }), /used/);
    });

  it("signs in and grants the perk when Square can't be told, and logs "
    + "it", async (t) => {
    const lines = capture(t);
    const stores = testStores();
    // No Square token in ENV: the call fails before any request.
    const made = await addInvite(stores, "friends", {
      square: "CUSTOMER_ID_1", now, env: ENV,
    });
    const link = await linkFor(stores, made, PAT);
    const res = await authHandle(
      new Request(`https://x/api/auth/verify?token=${link}`),
      { stores, env: ENV, now });

    assert.equal(res.status, 302);

    const saved = await getCustomer(stores, PAT);

    assert.deepEqual(saved.perks.map((p) => p.type), ["friends"]);
    assert.equal(saved.squareCustomerId, undefined);
    assert.ok(lines.some((l) => l.includes("\"invite.square-failed\"")));
    assert.ok(lines.some((l) => l.includes("\"square\":\"failed\"")));
  });

  it("uses the invite up on a perk already held, adding no second one",
    async (t) => {
      quiet(t);

      const stores = testStores();

      await addPerk(stores, PAT, "friends", { now });

      const made = await addInvite(stores, "friends", { now, env: ENV });
      const [invite] = await listInvites(stores, { now });
      const r = await finishInvite(stores, PAT, linkRecord(invite), {
        now, env: ENV,
      });

      assert.deepEqual(r, { ok: true, perk: null });
      assert.equal((await getCustomer(stores, PAT)).perks.length, 1);
      assert.equal((await listInvites(stores, { now }))[0].state, "used");
      assert.equal(made.id, invite.id);
    });

  it("lists an invite a perk holder used as used with nothing added "
    + "(qa on #733)", async (t) => {
    quiet(t);

    const stores = testStores();
    const said = [];
    const use = async (email) => {
      const made = await addInvite(stores, "friends", { now, env: ENV });
      const [invite] = (await listInvites(stores, { now }))
        .filter((r) => r.id === made.id);

      await finishInvite(stores, email, linkRecord(invite), { now, env: ENV });

      return made.id;
    };

    await addPerk(stores, PAT, "friends", { now });

    const burned = await use(PAT);
    const given = await use("sam@example.com");
    const rows = await listInvites(stores, { now });

    assert.equal(rows.find((r) => r.id === burned).granted, false);
    assert.equal(rows.find((r) => r.id === given).granted, undefined);

    await inviteCommand("list", [], { stores, out: (s) => said.push(s) });
    assert.match(said.find((s) => s.startsWith(burned)),
      /^inv-[0-9a-f]{12} {2}friends {2}used, nothing added {2}made /);
    assert.match(said.find((s) => s.startsWith(given)),
      /^inv-[0-9a-f]{12} {2}friends {2}used {2}made /);
  });

  it("ends an invite with its perk, even inside its 14 days", async (t) => {
    quiet(t);

    const stores = testStores();
    const made = await addInvite(stores, "friends", {
      end: "2026-10-08", now, env: ENV,
    });
    const state = async (day) => (await listInvites(stores, {
      now: instant(day, 12, 0, "America/New_York"),
    }))[0].state;

    assert.equal(await state("2026-10-08"), "open");
    assert.equal(await state("2026-10-09"), "expired");
    assert.equal((await checkInvite(stores, tokenOf(made.url), {
      now: instant("2026-10-09", 0, 30, "America/New_York"),
    })).ok, false, "dead from the first minute after the perk's last day");
  });

  it("asks for an address that looks like one, and closes the request "
    + "under maintenance", async (t) => {
    quiet(t);

    const stores = testStores();
    const made = await addInvite(stores, "friends", { now, env: ENV });
    const token = tokenOf(made.url);
    const bad = await inviteHandle(post("/api/invite/request", {
      token, email: "pat at example",
    }), { stores, env: ENV, now });

    assert.equal(bad.status, 422);
    assert.ok((await bad.json()).errors.email);

    await stores.jobs.set("setting/maintenance", {
      on: true, at: now.toISOString(), by: "test", epoch: 1,
    });

    const closed = await inviteHandle(post("/api/invite/request", {
      token, email: PAT,
    }), { stores, env: ENV, now });

    assert.equal(closed.status, 503);
  });

  it("lists each invite with its state and note for the farm",
    async (t) => {
      quiet(t);

      const stores = testStores();
      const said = [];

      await inviteCommand("add", ["free-delivery"], {
        stores, flags: { note: "the Smith place", end: "2027-01-31" },
        out: (s) => said.push(s), env: ENV,
      });
      assert.match(said.at(-1), /^https:\/\/x\/invite\/\?t=/);

      said.length = 0;
      await inviteCommand("list", [], { stores, out: (s) => said.push(s) });
      assert.equal(said.length, 1);
      assert.match(said[0], new RegExp("^inv-[0-9a-f]{12}  free-delivery  "
        + "open .*perk through 2027-01-31 .*the Smith place$"));
      await assert.rejects(inviteCommand("nope", [], {
        stores, out: () => {},
      }), /Usage/);
    });

  it("keeps the invite page's token in its own slot", () => {
    const items = new Map();
    const tab = {
      location: { href: "https://x/invite/?t=abc" },
      history: { state: null, replaceState: () => {} },
      storage: () => ({
        getItem: (k) => (items.has(k) ? items.get(k) : null),
        setItem: (k, v) => items.set(k, v),
        removeItem: (k) => items.delete(k),
      }),
      key: "nff_invite_token",
    };

    assert.equal(takeToken(tab), "abc");
    assert.deepEqual([...items.keys()], ["nff_invite_token"]);
    dropToken(tab);
    assert.equal(items.size, 0);
  });
});
