/* eslint-disable camelcase -- Square names its fields its way */
// Member codes (#131): each member's opaque ID, minted once and kept,
// on the record and its index; set as the reference_id of their Square
// profile, idempotent and logged; shown on the Membership tab as text
// and as a QR code of it; and the key tag page that prints it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle } from "../netlify/functions/membership.mjs";
import { renameCustomer } from "../netlify/functions/lib/admin.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { forgetFake } from "../netlify/functions/lib/fake-square.mjs";
import { auditLog } from "../netlify/functions/lib/group-log.mjs";
import { joinGroup, leaveGroup } from "../netlify/functions/lib/groups.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import {
  ensureMemberId, findMember, memberIdOf, newMemberId, syncMembers,
  syncSquareReference,
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
