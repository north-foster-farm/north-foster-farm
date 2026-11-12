/* eslint-disable camelcase -- Square names its fields its way */
// Member codes (#131): each member's opaque ID, minted once and kept,
// on the record and its index; set as the reference_id of their Square
// profile, idempotent and logged; shown on the Membership tab as text
// and as a QR code of it; and the key tag page that prints it.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { handle } from "../netlify/functions/membership.mjs";
import { renameCustomer } from "../netlify/functions/lib/admin.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { forgetFake } from "../netlify/functions/lib/fake-square.mjs";
import { auditLog } from "../netlify/functions/lib/group-log.mjs";
import { joinGroup, leaveGroup } from "../netlify/functions/lib/groups.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import { membersCommand } from "../bin/members.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  DRAIN_MAX, DRAIN_MS, RETRY_ALERT, RETRY_MAX, drainSquareQueue,
  ensureMemberId, findMember, memberIdOf,
  newMemberId, retryAfter, squareQueue, syncMembers, syncSquareReference,
} from "../netlify/functions/lib/member-id.mjs";
import {
  customerByMemberId, deleteCustomer, getCustomer, memberIdKey, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import {
  replaceableReference, setCustomerReference,
} from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { body } from "./recorded.mjs";

const now = new Date("2026-11-12T14:00:00Z");
const PAT = "pat@example.com";
const SAM = "sam@example.com";
const FARM = { role: "farm" };
const DEV = { SITE_CONTEXT: "dev", SQUARE_ENV: "fake" };
const LIVE = { SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "t",
  SQUARE_LOCATION_ID: "L" };

const setup = async () => {
  const stores = testStores();

  for (const [email, first] of [[PAT, "Pat"], [SAM, "Sam"]]) {
    await saveCustomer(stores, { email, firstName: first,
      lastName: "Example", name: `${first} Example`, phone: "" });
  }
  await joinGroup(stores, PAT, "vff", { now, via: "qr" });

  return stores;
};

// Draws that give the same eight characters `times` times, then others.
const repeating = (times) => {
  let n = 0;

  return (max) => {
    const round = Math.floor(n / 8);

    n += 1;

    return round < times ? 0 : (round + n) % max;
  };
};

const acts = async (stores, action) => (await auditLog(stores, "vff"))
  .filter((a) => a.action === action);

describe("the member ID", () => {
  it("is NFM- and eight characters of the pass alphabet", () => {
    const shape = /^NFM-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

    for (let i = 0; i < 50; i++) assert.match(newMemberId(), shape);
  });

  it("reads as typed or scanned, and nothing else", () => {
    assert.equal(memberIdOf("nfm-k3wm-7qpa"), "NFM-K3WM-7QPA");
    assert.equal(memberIdOf(" NFM K3WM 7QPA "), "NFM-K3WM-7QPA");
    assert.equal(memberIdOf("NFMK3WM7QPA"), "NFM-K3WM-7QPA");
    assert.equal(memberIdOf("NFF-2610-K3WM"), "");
    assert.equal(memberIdOf("NFM-K3WM-7QP0"), "", "no zero in the alphabet");
    assert.equal(memberIdOf("pat@example.com"), "");
  });

  it("is minted for a member, once, and logged once", async () => {
    const stores = await setup();
    const first = await ensureMemberId(stores, PAT, { by: FARM, now });
    const again = await ensureMemberId(stores, PAT, { by: FARM, now });
    const record = await getCustomer(stores, PAT);

    assert.equal(first.minted, true);
    assert.equal(again.minted, false);
    assert.equal(again.memberId, first.memberId);
    assert.equal(record.memberId, first.memberId);
    assert.equal(record.memberIdStatus, "active");
    assert.equal(record.memberIdSetAt, now.toISOString());
    assert.equal(record.memberGroup.id, "vff", "the membership is untouched");

    const minted = await acts(stores, "member-id.mint");

    assert.equal(minted.length, 1);
    assert.equal(minted[0].target, maskEmail(PAT));
    assert.ok(!JSON.stringify(minted[0]).includes(PAT), "address masked");
    assert.deepEqual(minted[0].before, { memberId: null });
    assert.deepEqual(minted[0].after, { memberId: first.memberId });
    assert.deepEqual(minted[0].by, { role: "farm" });
  });

  it("is not minted for someone in no group, or with no record",
    async () => {
      const stores = await setup();

      assert.equal(await ensureMemberId(stores, SAM, { by: FARM, now }), null);
      assert.equal(await ensureMemberId(stores, "nobody@example.com",
        { by: FARM, now }), null);
      assert.equal((await getCustomer(stores, SAM)).memberId, null);
    });

  it("writes nothing on a dry run", async () => {
    const stores = await setup();
    const r = await ensureMemberId(stores, PAT, {
      by: FARM, now, apply: false,
    });

    assert.deepEqual([r.memberId, r.minted], [null, true]);
    assert.equal((await getCustomer(stores, PAT)).memberId, null);
    assert.deepEqual(await acts(stores, "member-id.mint"), []);
  });

  it("never gives two members the same code", async () => {
    const stores = await setup();

    await joinGroup(stores, SAM, "vff", { now, via: "qr" });

    const a = await ensureMemberId(stores, PAT, {
      by: FARM, now, pick: repeating(1),
    });
    const b = await ensureMemberId(stores, SAM, {
      by: FARM, now, pick: repeating(1),
    });

    assert.notEqual(a.memberId, b.memberId);
    assert.equal((await customerByMemberId(stores, a.memberId)).email, PAT);
    assert.equal((await customerByMemberId(stores, b.memberId)).email, SAM);
  });

  it("stays with the customer through leaving, an address change and "
    + "is gone with the record", async () => {
    const stores = await setup();
    const { memberId } = await ensureMemberId(stores, PAT, { by: FARM, now });

    await leaveGroup(stores, PAT);
    assert.equal((await getCustomer(stores, PAT)).memberId, memberId);
    assert.equal((await findMember(stores, memberId.toLowerCase())).email,
      PAT, "found by the code as typed");

    const moved = "pat.new@example.com";

    await renameCustomer(stores, PAT, moved, {
      apply: true, env: DEV, now,
      news: { moveContact: async () => null },
      square: { renameCustomerEmail: async () => [] },
    });
    assert.equal((await customerByMemberId(stores, memberId)).email, moved);

    await deleteCustomer(stores, moved);
    assert.equal(await stores.customers.get(memberIdKey(memberId)), null);
    assert.equal(await customerByMemberId(stores, memberId), null);
  });
});

// Square as the real module meets it: the recorded answers, with the
// profile's reference as the test needs it, and every request kept.
const square = ({ found = true, reference = "NFF-2610-FIXT" } = {}) => {
  const sent = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;

    sent.push({ method: init.method, path,
      body: init.body ? JSON.parse(init.body) : null });

    let answer;

    if (path === "/v2/customers/search") {
      answer = body("square", found
        ? "customers-search-found" : "customers-search-none");
      if (found) answer.customers[0].reference_id = reference;
    } else if (init.method === "POST") {
      answer = body("square", "customer-create");
    } else {
      answer = body("square", "customer-update");
      answer.customer.reference_id = JSON.parse(init.body).reference_id;
    }

    return new Response(JSON.stringify(answer), { status: 200 });
  };

  return { sent, impl };
};

const PAT_RECORD = { email: PAT, firstName: "Pat", lastName: "Example",
  phone: "" };

describe("the code on the Square profile", () => {
  it("replaces only a reference the site wrote", () => {
    assert.ok(replaceableReference(null));
    assert.ok(replaceableReference(""));
    assert.ok(replaceableReference("NFF-2610-K3WM"), "a checkout's mark");
    assert.ok(replaceableReference("NFM-K3WM-7QPA"), "an older code");
    assert.ok(!replaceableReference("LOYALTY-0042"));
  });

  it("sets the reference_id of the profile checkout finds", async () => {
    const net = square();
    const r = await setCustomerReference(PAT_RECORD, "NFM-K3WM-7QPA", {
      env: LIVE, fetchImpl: net.impl,
    });

    assert.equal(r.action, "updated");
    assert.equal(r.was, "NFF-2610-FIXT");
    assert.equal(r.referenceId, "NFM-K3WM-7QPA");
    assert.deepEqual(net.sent.map((s) => `${s.method} ${s.path}`), [
      "POST /v2/customers/search", `PUT /v2/customers/${r.customerId}`,
    ]);
    assert.deepEqual(net.sent[0].body, {
      query: { filter: { email_address: { exact: PAT } } }, limit: 1,
    }, "the search checkout sends");
    assert.deepEqual(net.sent[1].body, { reference_id: "NFM-K3WM-7QPA" },
      "the reference alone: the profile's other fields stay");
  });

  it("changes nothing when the profile already says so, or someone "
    + "else's reference is there", async () => {
    for (const [reference, action] of [
      ["NFM-K3WM-7QPA", "unchanged"], ["LOYALTY-0042", "conflict"],
    ]) {
      const net = square({ reference });
      const r = await setCustomerReference(PAT_RECORD, "NFM-K3WM-7QPA", {
        env: LIVE, fetchImpl: net.impl,
      });

      assert.equal(r.action, action);
      assert.equal(net.sent.length, 1, "the search only");
    }
  });

  it("makes a profile with the code when there is none, keyed by it",
    async () => {
      const net = square({ found: false });
      const r = await setCustomerReference(PAT_RECORD, "NFM-K3WM-7QPA", {
        env: LIVE, fetchImpl: net.impl,
      });

      assert.equal(r.action, "created");
      assert.deepEqual(net.sent[1].body, {
        idempotency_key: "member-NFM-K3WM-7QPA", given_name: "Pat",
        family_name: "Example", email_address: PAT,
        reference_id: "NFM-K3WM-7QPA",
      });
    });

  it("only reads on a dry run", async () => {
    for (const [found, action] of [[true, "would-update"],
      [false, "would-create"]]) {
      const net = square({ found });
      const r = await setCustomerReference(PAT_RECORD, "NFM-K3WM-7QPA", {
        env: LIVE, fetchImpl: net.impl, apply: false,
      });

      assert.equal(r.action, action);
      assert.equal(net.sent.length, 1);
    }
  });

  it("is logged when it changed Square, and not when it didn't",
    async () => {
      const stores = await setup();
      const own = await ensureMemberId(stores, PAT, { by: FARM, now });
      const set = await syncSquareReference(stores, own.customer, {
        by: FARM, env: LIVE, fetchImpl: square().impl, now,
      });
      const same = await syncSquareReference(stores, own.customer, {
        by: FARM, env: LIVE, now,
        fetchImpl: square({ reference: own.memberId }).impl,
      });
      const logged = await acts(stores, "member-id.square");

      assert.equal(set.action, "updated");
      assert.equal(same.action, "unchanged");
      assert.equal(logged.length, 1);
      assert.equal(logged[0].target, maskEmail(PAT));
      assert.deepEqual(logged[0].before, { referenceId: "NFF-2610-FIXT" });
      assert.equal(logged[0].after.referenceId, own.memberId);
    });

  it("runs twice through the fake with one change", async () => {
    forgetFake();

    const stores = await setup();
    const first = await syncMembers(stores, [PAT, SAM], { by: FARM,
      env: DEV, now });
    const second = await syncMembers(stores, [PAT, SAM], { by: FARM,
      env: DEV, now });

    assert.equal(first[0].minted, true);
    assert.equal(first[0].square.action, "created");
    assert.deepEqual([first[1].memberId, first[1].square], [null, null],
      "not in a group: nothing done");
    assert.equal(second[0].memberId, first[0].memberId);
    assert.equal(second[0].minted, false);
    assert.equal(second[0].square.action, "unchanged");
    assert.equal((await acts(stores, "member-id.mint")).length, 1);
    assert.equal((await acts(stores, "member-id.square")).length, 1);
  });
});

const call = (stores, path, headers) => handle(new Request(`http://x${path}`, {
  headers: { "sec-fetch-site": "same-origin", ...headers },
}), { stores, env: { URL: "https://x" }, now });

const cookie = async (stores, email) => ({
  cookie: `nff_session=${(await createSession(stores, email, { now })).id}`,
});

describe("the Membership tab's code", () => {
  it("shows a member their code, minted on the first look, as the "
    + "member's act", async () => {
    const stores = await setup();
    const view = await (await call(stores, "/api/membership",
      await cookie(stores, PAT))).json();
    const again = await (await call(stores, "/api/membership",
      await cookie(stores, PAT))).json();

    assert.match(view.member.code.id, /^NFM-/);
    assert.equal(again.member.code.id, view.member.code.id);

    const minted = await acts(stores, "member-id.mint");

    assert.equal(minted.length, 1);
    assert.equal(minted[0].by.role, "member");
  });

  it("draws the code as a QR code of the ID alone", async () => {
    const stores = await setup();
    const headers = await cookie(stores, PAT);
    const { member } = await (await call(stores, "/api/membership",
      headers)).json();
    const res = await call(stores, "/api/membership/code", headers);
    const svg = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^image\/svg\+xml/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(svg, new RegExp(`aria-label="Member code ${member.code.id}"`));
    assert.match(svg, /<path fill="#000" d="M/);

    const saved = await call(stores, "/api/membership/code?download=1",
      headers);

    assert.match(saved.headers.get("content-disposition"),
      new RegExp(`member-code-${member.code.id}\\.svg`));
  });

  it("gives no code to a stranger, or before one is minted", async () => {
    const stores = await setup();

    assert.equal((await call(stores, "/api/membership/code")).status, 401);
    assert.equal((await call(stores, "/api/membership/code",
      await cookie(stores, SAM))).status, 404);
    assert.equal((await call(stores, "/api/membership/code",
      await cookie(stores, PAT))).status, 404, "the tab mints it first");
  });

  it("mints nothing while the site is in maintenance", async () => {
    const stores = await setup();

    await stores.jobs.set("setting/maintenance", { on: true, epoch: 1 });

    const view = await (await call(stores, "/api/membership",
      await cookie(stores, PAT))).json();

    assert.equal(view.member.code, null);
    assert.equal((await getCustomer(stores, PAT)).memberId, null);
  });
});

describe("two first looks at once", () => {
  const claims = async (stores) => stores.customers.list("member-id/");

  it("mint one code: no leftover claim, one audit entry", async () => {
    const stores = await setup();
    const [a, b] = await Promise.all([
      ensureMemberId(stores, PAT, { by: { role: "member", email: PAT }, now }),
      ensureMemberId(stores, PAT, { by: { role: "member", email: PAT }, now }),
    ]);

    assert.equal(a.memberId, b.memberId);
    assert.deepEqual([a.minted, b.minted].sort(), [false, true]);
    assert.equal((await getCustomer(stores, PAT)).memberId, a.memberId);
    assert.deepEqual((await claims(stores)).map((k) => k.key),
      [memberIdKey(a.memberId)]);
    assert.equal((await acts(stores, "member-id.mint")).length, 1);
    assert.equal((await squareQueue(stores)).length, 1);
  });

  it("through two tabs of the Membership tab", async () => {
    const stores = await setup();
    const [one, two] = await Promise.all([
      call(stores, "/api/membership", await cookie(stores, PAT)),
      call(stores, "/api/membership", await cookie(stores, PAT)),
    ].map(async (r) => (await r).json()));

    assert.equal(one.member.code.id, two.member.code.id);
    assert.equal((await claims(stores)).length, 1);
    assert.equal((await acts(stores, "member-id.mint")).length, 1);
  });

  it("keeps a change to the record made meanwhile, and mints after it",
    async () => {
      const stores = await setup();
      const swap = stores.customers.swap;
      let raced = false;

      // Another write lands between this mint's read and its swap.
      stores.customers.swap = async (key, value, etag) => {
        if (!raced) {
          raced = true;
          await stores.customers.set(key, {
            ...(await stores.customers.get(key)), phone: "401-555-0100",
          });
        }

        return swap(key, value, etag);
      };

      const r = await ensureMemberId(stores, PAT, { by: FARM, now });
      const record = await getCustomer(stores, PAT);

      assert.equal(r.minted, true);
      assert.equal(record.memberId, r.memberId);
      assert.equal(record.phone, "401-555-0100", "the other write stands");
      assert.equal((await claims(stores)).length, 1, "the lost claim went");
      assert.equal((await acts(stores, "member-id.mint")).length, 1);
    });
});

describe("a code minted on the site reaches Square", () => {
  const down = async () => new Response(JSON.stringify({
    errors: [{ category: "API_ERROR", code: "SERVICE_UNAVAILABLE" }],
  }), { status: 503 });

  it("is queued by the tab's first look, which calls no one", async () => {
    const stores = await setup();
    const { member } = await (await call(stores, "/api/membership",
      await cookie(stores, PAT))).json();
    const queue = await squareQueue(stores);

    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, member.code.id);
    assert.equal(queue[0].email, PAT);
    assert.deepEqual(queue[0].by, { role: "member" });
    assert.equal(queue[0].tries, 0);
    assert.equal(queue[0].nextAt, now.toISOString());
  });

  it("is set by the jobs run through syncSquareReference, logged as the "
    + "member's, and leaves the queue", async () => {
    const stores = await setup();
    const own = await ensureMemberId(stores, PAT, {
      by: { role: "member", email: PAT }, now,
    });
    const net = square();
    const { done, left } = await drainSquareQueue(stores, {
      env: LIVE, fetchImpl: net.impl, now,
    });

    assert.deepEqual(done, [{ id: own.memberId, outcome: "updated",
      tries: 1 }]);
    assert.equal(left, 0);
    assert.deepEqual(net.sent[1].body, { reference_id: own.memberId });
    assert.deepEqual(await squareQueue(stores), []);

    const logged = await acts(stores, "member-id.square");

    assert.equal(logged.length, 1);
    assert.equal(logged[0].by.role, "member");
    assert.equal(logged[0].target, maskEmail(PAT));
  });

  it("waits longer after each failure, alerts from the fourth, and is "
    + "set once Square is back", async () => {
    const stores = await setup();
    const own = await ensureMemberId(stores, PAT, { by: FARM, now });
    let at = now;

    for (let tries = 1; tries <= RETRY_ALERT; tries++) {
      const { done: [d] } = await drainSquareQueue(stores, {
        env: LIVE, fetchImpl: down, now: at,
      });
      const [entry] = await squareQueue(stores);

      assert.equal(d.outcome, "retry");
      assert.equal(d.tries, tries);
      assert.equal(d.alert, tries >= RETRY_ALERT);
      assert.equal(entry.tries, tries);
      assert.equal(Date.parse(entry.nextAt), at.getTime() + retryAfter(tries));
      assert.ok(entry.lastError);
      assert.equal(entry.id, own.memberId);

      // Not due again before its time.
      assert.deepEqual(await drainSquareQueue(stores, {
        env: LIVE, fetchImpl: down, now: new Date(at.getTime() + 1000),
      }), { done: [], left: 0 });
      at = new Date(entry.nextAt);
    }

    const { done: [back] } = await drainSquareQueue(stores, {
      env: LIVE, fetchImpl: square().impl, now: at,
    });

    assert.equal(back.outcome, "updated");
    assert.deepEqual(await squareQueue(stores), []);
    assert.equal((await getCustomer(stores, PAT)).memberId, own.memberId,
      "the code stood all along");
  });

  it("waits at most a day between tries", () => {
    assert.equal(retryAfter(1), 15 * 60_000);
    assert.equal(retryAfter(2), 30 * 60_000);
    assert.equal(retryAfter(20), 24 * 60 * 60_000);
  });

  it("is dropped when the code is no longer the record's, and on a "
    + "conflict", async () => {
    const stores = await setup();
    const own = await ensureMemberId(stores, PAT, { by: FARM, now });

    await deleteCustomer(stores, PAT);
    assert.deepEqual((await drainSquareQueue(stores, {
      env: LIVE, fetchImpl: down, now,
    })).done, [{ id: own.memberId, outcome: "dropped", tries: 1 }]);

    const again = await setup();
    const mine = await ensureMemberId(again, PAT, { by: FARM, now });

    assert.deepEqual((await drainSquareQueue(again, {
      env: LIVE, fetchImpl: square({ reference: "LOYALTY-0042" }).impl, now,
    })).done, [{ id: mine.memberId, outcome: "conflict", tries: 1 }]);
    assert.deepEqual(await squareQueue(again), []);
  });

  it("is off the queue once the CLI sets it, and stays on when the CLI "
    + "can't", async () => {
    const stores = await setup();

    await syncMembers(stores, [PAT], { by: FARM, env: LIVE, now,
      fetchImpl: down });
    assert.equal((await squareQueue(stores)).length, 1, "the jobs retry it");

    await syncMembers(stores, [PAT], { by: FARM, env: LIVE, now,
      fetchImpl: square().impl });
    assert.deepEqual(await squareQueue(stores), []);
  });

  // Square's answer to a bad token: no use asking again.
  const refuses = async () => new Response(JSON.stringify({
    errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }],
  }), { status: 401 });

  it("is refused for good on a SquareError that isn't retryable: kept, "
    + "named, never tried again", async () => {
    const stores = await setup();
    const own = await ensureMemberId(stores, PAT, { by: FARM, now });
    const { done } = await drainSquareQueue(stores, {
      env: LIVE, fetchImpl: refuses, now,
    });

    assert.equal(done.length, 1);
    assert.equal(done[0].outcome, "refused");
    assert.equal(done[0].id, own.memberId);
    assert.match(done[0].error, /401.*UNAUTHORIZED/);
    assert.equal(done[0].alert, undefined, "not a retry's alert");

    const [entry] = await squareQueue(stores);

    assert.equal(entry.refused, true);
    assert.equal(entry.refusedAt, now.toISOString());
    assert.match(entry.lastError, /UNAUTHORIZED/);

    // Never tried again by the jobs, however late.
    const net = square();

    assert.deepEqual(await drainSquareQueue(stores, { env: LIVE,
      fetchImpl: net.impl, now: new Date(now.getTime() + RETRY_MAX * 2) }),
    { done: [], left: 0 });
    assert.deepEqual(net.sent, []);
  });

  it("goes on retrying on a timeout or a network error", async () => {
    const stores = await setup();

    await ensureMemberId(stores, PAT, { by: FARM, now });

    const { done: [d] } = await drainSquareQueue(stores, {
      env: LIVE, now, fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    assert.equal(d.outcome, "retry");
    assert.ok(!(await squareQueue(stores))[0].refused);
  });

  // Three members of vff with a code each, queued a minute apart, PAT's
  // the oldest.
  const three = async () => {
    const stores = await setup();
    const LEE = "lee@example.com";

    await saveCustomer(stores, { email: LEE, firstName: "Lee",
      lastName: "Example", name: "Lee Example", phone: "" });
    await joinGroup(stores, SAM, "vff", { now, via: "qr" });
    await joinGroup(stores, LEE, "vff", { now, via: "qr" });

    const ids = [];

    for (const [i, email] of [PAT, SAM, LEE].entries()) {
      ids.push((await ensureMemberId(stores, email, {
        by: FARM, now: new Date(now.getTime() + i * 60_000),
      })).memberId);
    }

    return { stores, ids, at: new Date(now.getTime() + 5 * 60_000) };
  };

  it("sets at most DRAIN_MAX a run, the longest waiting first",
    async () => {
      assert.equal(DRAIN_MAX, 10);

      const { stores, ids, at } = await three();
      const first = await drainSquareQueue(stores, {
        env: LIVE, fetchImpl: square().impl, now: at, max: 2,
      });

      assert.deepEqual(first.done.map((d) => d.id), ids.slice(0, 2));
      assert.equal(first.left, 1);

      const second = await drainSquareQueue(stores, {
        env: LIVE, fetchImpl: square().impl, now: at, max: 2,
      });

      assert.deepEqual(second.done.map((d) => d.id), ids.slice(2));
      assert.equal(second.left, 0);
    });

  it("starts none after DRAIN_MS, and cuts Square's calls at it",
    async () => {
      assert.ok(DRAIN_MS <= 10_000, "well inside the function's 30 s");

      const { stores, ids, at } = await three();
      let t = 0;
      const clock = () => (t += 3000);
      const { done, left } = await drainSquareQueue(stores, {
        env: LIVE, fetchImpl: square().impl, now: at, ms: 5000, clock,
      });

      assert.deepEqual(done.map((d) => d.id), ids.slice(0, 1));
      assert.equal(left, 2);

      // A call that would outlive the deadline is cut, as a retry.
      const stall = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort",
          () => reject(init.signal.reason));
      });
      const started = Date.now();
      const cut = await drainSquareQueue(stores, {
        env: LIVE, fetchImpl: stall, now: at, ms: 300,
      });

      assert.ok(Date.now() - started < 3000, "not CALL_MS per code");
      assert.equal(cut.done[0].outcome, "retry");
      assert.ok(cut.done.length + cut.left === 2);
    });

  // A jobs run with a heartbeat, alert mail, and Square answering
  // `squareImpl` (the heartbeat's pings answer 200).
  const jobsRun = async (stores, squareImpl) => {
    const calls = [];
    const sent = [];
    const report = await runJobs(stores, {
      now, realNow: now,
      env: { ...LIVE, HEALTHCHECKS_JOBS_URL: "https://hc/jobs",
        DEV_NOTIFICATIONS_EMAIL: "dev@example.com", MAIL_DRIVER: "test" },
      fetchImpl: async (url, init) => {
        calls.push(String(url));

        return String(url).startsWith("https://hc/")
          ? new Response("OK") : squareImpl(url, init);
      },
      mail: async (m) => {
        sent.push(m);

        return { id: "m" };
      },
    });

    return { report, calls, sent: sent.map((m) => m.subject) };
  };

  it("runs last in the jobs run, after the heartbeat", async () => {
    const stores = await setup();

    await ensureMemberId(stores, PAT, { by: FARM, now });

    const { report, calls } = await jobsRun(stores, square().impl);
    const beat = calls.findIndex((u) => u.startsWith("https://hc/jobs"));
    const set = calls.findIndex((u) => u.includes("/v2/customers"));

    assert.deepEqual(report.memberCodes.map((d) => d.outcome), ["updated"]);
    assert.ok(beat >= 0 && set > beat, calls.join("\n"));
    assert.ok(report.creditSwept && report.invariants, "the steps before");
  });

  it("alerts once for a code Square refuses, by its code alone",
    async () => {
      const stores = await setup();
      const own = await ensureMemberId(stores, PAT, { by: FARM, now });
      const first = await jobsRun(stores, refuses);

      assert.deepEqual(first.report.memberCodes.map((d) => d.outcome),
        ["refused"]);
      assert.deepEqual(first.sent.filter((s) => /member\./.test(s)),
        ["Site alert: member.square_refused"]);
      assert.ok(!first.report.errors.some((e) => e.step === "memberSquare"),
        "not a jobs error: the heartbeat has gone");

      const again = await jobsRun(stores, refuses);

      assert.deepEqual(again.report.memberCodes, []);
      assert.deepEqual(again.sent.filter((s) => /member\./.test(s)), [],
        "once");
      assert.ok(own.memberId);
    });

  it("alerts when a code keeps failing, from the fourth try", async () => {
    const stores = await setup();
    const own = await ensureMemberId(stores, PAT, { by: FARM, now });
    const key = `member-square/${own.memberId}`;

    await stores.jobs.set(key, {
      ...(await stores.jobs.get(key)), tries: RETRY_ALERT - 1,
    });

    const { report, sent } = await jobsRun(stores, down);

    assert.deepEqual(report.memberCodes.map((d) => d.outcome), ["retry"]);
    assert.ok(sent.includes("Site alert: member.square_retrying"),
      sent.join("\n"));
  });
});

// The commands of bin/nff members, as gate-cli.test.mjs drives
// bin/gate.mjs.
const members = async (stores, args, { flags = {}, env = DEV,
  fetchImpl } = {}) => {
  const lines = [];
  const written = [];
  const [action, ...rest] = args;

  await membersCommand(action, rest, {
    stores, flags, env, fetchImpl, now, out: (line) => lines.push(line),
    writeFile: (path, text) => written.push({ path, text }),
  });

  return { lines, written };
};

describe("bin/nff members", () => {
  it("show: a member with no code yet, then with one, by address or code",
    async () => {
      forgetFake();

      const stores = await setup();

      assert.deepEqual((await members(stores, ["show", PAT])).lines,
        [`${PAT}  no code yet  vff`]);

      const { memberId } = await ensureMemberId(stores, PAT, {
        by: FARM, now,
      });

      assert.deepEqual((await members(stores, ["show", PAT])).lines, [
        `${PAT}  ${memberId}  vff`,
        "Square: no profile under this address; members mint makes one",
        `Jobs: waiting to be set in Square, next try ${now.toISOString()}`,
      ]);
      assert.deepEqual((await members(stores, ["show",
        memberId.toLowerCase()])).lines[0], `${PAT}  ${memberId}  vff`);
      assert.deepEqual((await members(stores, ["show", SAM])).lines,
        [`${SAM}  no code yet  in no group`]);
    });

  it("show: what the Square profile says, and only reads it", async () => {
    const stores = await setup();
    const { memberId } = await ensureMemberId(stores, PAT, { by: FARM, now });

    for (const [reference, said] of [
      [memberId, "the profile's reference_id is the code"],
      ["NFF-2610-FIXT", "reference_id is NFF-2610-FIXT; members mint sets it"],
      ["LOYALTY-0042", "reference_id is LOYALTY-0042, which the site "
        + "didn't write; change it in the Square Dashboard"],
    ]) {
      const net = square({ reference });
      const { lines } = await members(stores, ["show", PAT], {
        env: LIVE, fetchImpl: net.impl,
      });

      assert.equal(lines[1], `Square: ${said}`);
      assert.deepEqual(net.sent.map((s) => s.method), ["POST"], "a search");
    }
    assert.deepEqual(await acts(stores, "member-id.square"), []);
  });

  it("show --out: the code's QR as an SVG, once there is a code",
    async () => {
      forgetFake();

      const stores = await setup();

      await assert.rejects(members(stores, ["show", PAT],
        { flags: { out: "tag.svg" } }), /members mint first/);

      const { memberId } = await ensureMemberId(stores, PAT, {
        by: FARM, now,
      });
      const { lines, written } = await members(stores, ["show", PAT],
        { flags: { out: "tag.svg" } });

      assert.equal(lines.at(-1), "Wrote tag.svg.");
      assert.equal(written[0].path, "tag.svg");
      assert.match(written[0].text, /^<svg/);
      assert.match(written[0].text,
        new RegExp(`aria-label="Member code ${memberId}"`));
    });

  // PAT's code, queued and then refused by Square in a jobs drain.
  const refusedCode = async () => {
    const stores = await setup();
    const { memberId } = await ensureMemberId(stores, PAT, { by: FARM, now });

    await drainSquareQueue(stores, { env: LIVE, now, fetchImpl: async () =>
      new Response(JSON.stringify({ errors: [{
        category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED",
      }] }), { status: 401 }) });

    return { stores, memberId };
  };
  const REFUSED = `Square refused it on ${now.toISOString()} (Square 401 on `
    + "/v2/customers/search (UNAUTHORIZED)), after 1 try; the jobs won't "
    + "try again. members mint sets it";

  it("show: names a code Square refused", async () => {
    const { stores, memberId } = await refusedCode();
    const { lines } = await members(stores, ["show", memberId], {
      env: LIVE, fetchImpl: square().impl,
    });

    assert.equal(lines.at(-1), `Jobs: ${REFUSED}`);
  });

  it("sync and mint: name a code Square refused, and end it once set",
    async () => {
      const { stores, memberId } = await refusedCode();
      const { lines } = await members(stores, ["sync", "vff"], {
        env: LIVE, fetchImpl: square().impl,
      });

      assert.deepEqual(lines, [
        `${PAT}  ${memberId}  set in Square`,
        `  ${REFUSED}`,
      ]);
      assert.deepEqual(await squareQueue(stores), []);
      assert.deepEqual((await members(stores, ["mint", PAT], {
        env: LIVE, fetchImpl: square({ reference: memberId }).impl,
      })).lines, [`${PAT}  ${memberId}  Square already has it`]);
    });

  it("show: refuses someone with no record", async () => {
    await assert.rejects(members(await setup(), ["show", "x@example.com"]),
      /No customer for "x@example\.com"/);
  });

  it("mint --dry-run: says what it would do and writes nothing",
    async () => {
      const stores = await setup();
      const net = square();
      const { lines } = await members(stores, ["mint", PAT], {
        flags: { "dry-run": true }, env: LIVE, fetchImpl: net.impl,
      });

      assert.deepEqual(lines, [
        `${PAT}  (new code)  would be minted  would be minted, then set in `
          + "Square",
        "--dry-run: nothing was written.",
      ]);
      assert.equal((await getCustomer(stores, PAT)).memberId, null);
      assert.deepEqual(net.sent, [], "Square not even read");
      assert.deepEqual(await squareQueue(stores), []);
    });

  it("mint: mints and sets it, then a second run changes nothing",
    async () => {
      const stores = await setup();
      const first = await members(stores, ["mint", PAT], {
        env: LIVE, fetchImpl: square().impl,
      });
      const { memberId } = await getCustomer(stores, PAT);

      assert.deepEqual(first.lines, [`${PAT}  ${memberId}  minted  set in `
        + "Square"]);
      assert.deepEqual(await squareQueue(stores), []);

      const second = await members(stores, ["mint", PAT], {
        env: LIVE, fetchImpl: square({ reference: memberId }).impl,
      });

      assert.deepEqual(second.lines,
        [`${PAT}  ${memberId}  Square already has it`]);
      assert.equal((await acts(stores, "member-id.mint")).length, 1);
      assert.equal((await acts(stores, "member-id.square")).length, 1);
    });

  it("mint: names a conflict, someone in no group, and an error",
    async () => {
      const stores = await setup();
      const conflict = await members(stores, ["mint", PAT], {
        env: LIVE, fetchImpl: square({ reference: "LOYALTY-0042" }).impl,
      });
      const { memberId } = await getCustomer(stores, PAT);

      assert.deepEqual(conflict.lines, [`${PAT}  ${memberId}  minted  NOT `
        + "set: the Square profile's reference_id is LOYALTY-0042"]);
      assert.deepEqual((await members(stores, ["mint", SAM])).lines,
        [`${SAM}  not in a group: nothing done`]);

      const failed = await members(stores, ["mint", PAT], {
        env: LIVE, fetchImpl: async () => {
          throw new Error("Square is down");
        },
      });

      assert.match(failed.lines[0], new RegExp(`^${PAT}  error: `));
      await assert.rejects(members(stores, ["mint"]), /members mint <email>/);
    });

  it("sync: every member of the group, through the fake", async () => {
    forgetFake();

    const stores = await setup();
    const { lines } = await members(stores, ["sync", "vff"]);
    const { memberId } = await getCustomer(stores, PAT);

    assert.deepEqual(lines, [`${PAT}  ${memberId}  minted  a Square profile `
      + "made with it"]);
    assert.deepEqual((await members(stores, ["sync", "vff"],
      { flags: { "dry-run": true } })).lines, [
      `${PAT}  ${memberId}  Square already has it`,
      "--dry-run: nothing was written.",
    ]);
  });

  it("sync: a group with no members, an unknown group, a bad command",
    async () => {
      const stores = testStores();

      assert.deepEqual((await members(stores, ["sync", "vff"])).lines,
        ["No members."]);
      await assert.rejects(members(stores, ["sync", "nope"]),
        /Unknown group "nope"/);
      await assert.rejects(members(stores, ["retire", PAT]),
        /Unknown command "members retire"/);
    });
});

describe("the pages", () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url),
    "utf8");

  it("put the code on the tab, with the key tag's link", async () => {
    const html = await read("layouts/account/single.html");

    assert.match(html, /data-mem-code hidden/);
    assert.match(html, /id="mem-code-id"/);
    assert.match(html, /href="\{\{ "\/account\/member-tag\/" \| relURL \}\}"/);
  });

  it("print the tag at 1.25 x 2.5 in, kept out of search", async () => {
    const scss = await read("assets/styles/components/_member-tag.scss");
    const page = await read("content/member-tag.md");

    assert.match(scss, /\$member-tag-width: 2\.5in;/);
    assert.match(scss, /\$member-tag-height: 1\.25in;/);
    assert.match(page, /url: "\/account\/member-tag\/"/);
    assert.match(page, /sitemap:\n {2}disable: true/);
  });
});
