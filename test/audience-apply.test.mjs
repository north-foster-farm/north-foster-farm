// Names set on a record and its Resend contact, and the batch cleanup
// of the imported list (#496): `customers set <email> first=.. last=..`
// and `audience apply <csv>`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAudience, removeCustomer, setNames,
} from "../netlify/functions/lib/admin.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import {
  parseCsv, syncAudience,
} from "../netlify/functions/lib/news.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-27T12:00:00Z");
const env = {
  SITE_URL: "https://northfosterfarm.com",
  RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k",
};
const PAT = "pat.example@gmail.test";
const SAM = "sam.sample@example.org";
const LEE = "lee.duplicate@example.net";

// Resend's audience, kept in memory. The answers have the shape of
// Resend's contacts API as its reference documents it (list, update,
// remove); no recorded sandbox response was at hand on the cloud
// runner (2026-10-27). Its fields are snake case.
/* eslint-disable camelcase */
const resendFake = (emails, { fail = null } = {}) => {
  const contacts = emails.map((email, i) => ({
    id: `c${i}`, email, first_name: "", last_name: "",
    created_at: "2026-10-20 12:00:00.000000+00", unsubscribed: false,
  }));
  const calls = [];
  const answer = (status, body) => ({
    ok: status < 400, status, json: async () => body,
  });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const email = decodeURIComponent(pathname.split("/contacts/")[1] || "");
    const i = contacts.findIndex((c) => c.email === email);

    calls.push({ method, pathname, body });
    if (fail && method === fail) {
      return answer(500, {
        statusCode: 500, name: "internal_server_error",
        message: `Could not reach ${pathname}`,
      });
    }
    if (method === "GET") {
      return answer(200, { object: "list", data: contacts });
    }
    if (method === "POST") {
      contacts.push({ id: `c${contacts.length}`, ...body });

      return answer(200, { object: "contact", id: `c${contacts.length}` });
    }
    if (i < 0) {
      return answer(404, {
        statusCode: 404, name: "not_found", message: "Contact not found",
      });
    }
    if (method === "PATCH") {
      Object.assign(contacts[i], body);

      return answer(200, { object: "contact", id: contacts[i].id });
    }

    const [gone] = contacts.splice(i, 1);

    return answer(200, { object: "contact", contact: gone.id, deleted: true });
  };

  return { contacts, calls, fetchImpl };
};

const writes = (calls) => calls.filter((c) => c.method !== "GET");

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

// No full address, nor a local part or domain long enough to name one.
const leaks = (text, address) => {
  const [local, domain] = address.split("@");

  return text.toLowerCase().includes(address)
    || text.includes(encodeURIComponent(address))
    || (local.length > 6 && text.includes(local))
    || (domain.length > 6 && text.includes(domain));
};

const customer = (email, first = "", last = "") => ({
  email, firstName: first, lastName: last,
  name: [first, last].filter(Boolean).join(" "), phone: "", avatar: null,
  discountGroup: null, address: null, marketing: true,
  marketingAt: "2024-07-12T12:00:00.000Z", marketingSource: "import",
  createdAt: "2024-07-12T12:00:00.000Z",
});

describe("customers set <email> first=.. last=..", () => {
  it("sets the record's names and the Resend contact's", async (t) => {
    const stores = testStores();
    const resend = resendFake([PAT]);

    await saveCustomer(stores, customer(PAT, "Pat"));

    const lines = capture(t);
    const report = await setNames(stores, "Pat.Example@Gmail.test",
      { first: " Pat ", last: "Example" },
      { by: "james", env, fetchImpl: resend.fetchImpl });
    const saved = await getCustomer(stores, PAT);

    assert.equal(saved.firstName, "Pat");
    assert.equal(saved.lastName, "Example");
    assert.equal(saved.name, "Pat Example");
    assert.equal(report.resend, "renamed");
    assert.deepEqual(report.changed, ["lastName", "name"]);
    assert.deepEqual(writes(resend.calls), [{
      method: "PATCH",
      pathname: `/audiences/aud/contacts/${encodeURIComponent(PAT)}`,
      body: { first_name: "Pat", last_name: "Example" },
    }]);

    const line = JSON.parse(lines.find((l) => l.includes("customer.renamed")));

    assert.equal(line.record, maskEmail(PAT));
    assert.equal(line.by, "james");
    assert.equal(line.outcome, "renamed");
    assert.ok(line._time);
    assert.ok(!lines.some((l) => leaks(l, PAT)), "no full address");
    assert.ok(!lines.some((l) => l.includes("Example")), "no names logged");
  });

  it("keeps a name not given, and the record without a contact",
    async () => {
      const stores = testStores();
      const resend = resendFake([]);

      await saveCustomer(stores, customer(PAT, "Pat", "Example"));

      const report = await setNames(stores, PAT, { first: "Patricia" },
        { env, fetchImpl: resend.fetchImpl });

      assert.equal((await getCustomer(stores, PAT)).name, "Patricia Example");
      assert.equal(report.resend, "none");
      assert.deepEqual(writes(resend.calls), []);
    });

  it("writes nothing on a dry run, and logs nothing", async (t) => {
    const stores = testStores();
    const resend = resendFake([PAT]);

    await saveCustomer(stores, customer(PAT));

    const lines = capture(t);
    const report = await setNames(stores, PAT, { first: "Pat", last: "E" },
      { dryRun: true, env, fetchImpl: resend.fetchImpl });

    assert.equal(report.resend, "renamed");
    assert.equal(report.name, "Pat E");
    assert.equal((await getCustomer(stores, PAT)).firstName, "");
    assert.deepEqual(writes(resend.calls), []);
    assert.deepEqual(lines, []);
  });

  it("keeps the record's change when Resend fails, the address masked",
    async (t) => {
      const stores = testStores();
      const resend = resendFake([PAT], { fail: "PATCH" });

      await saveCustomer(stores, customer(PAT));

      const lines = capture(t);
      const report = await setNames(stores, PAT, { first: "Pat" },
        { env, fetchImpl: resend.fetchImpl });

      assert.equal((await getCustomer(stores, PAT)).firstName, "Pat");
      assert.match(report.resend, /^not reached: Resend 500/);
      assert.ok(!leaks(report.resend, PAT));
      assert.ok(!lines.some((l) => leaks(l, PAT)));
    });
});

describe("audience apply <csv>", () => {
  const CSV = "action,email,first,last\n"
    + `keep,${PAT},Pat,Example\n`
    + `keep,${SAM},,Sample\n`
    + `remove,${LEE},,\n`
    + "keep,nobody.here@example.com,No,One\n"
    + `hold,${SAM},,\n`
    + "remove,not-an-address,,\n";
  const seed = async () => {
    const stores = testStores();

    await saveCustomer(stores, customer(PAT));
    await saveCustomer(stores, customer(SAM, "Sam"));
    await saveCustomer(stores, customer(LEE, "Lee"));
    await saveOrder(stores, {
      id: "NFF-1", status: "fulfilled", submittedAt: "2026-09-01T12:00:00Z",
      customer: { firstName: "Lee", lastName: "", name: "Lee", email: LEE,
        phone: "", contact: "email" },
      lines: [], totals: { total: 0 }, history: [],
    });

    return stores;
  };

  it("sets names on keep rows, forgets remove rows, and reports masked",
    async (t) => {
      const stores = await seed();
      const resend = resendFake([PAT, SAM, LEE]);
      const lines = capture(t);
      const report = await applyAudience(stores, parseCsv(CSV), {
        by: "james", env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      assert.deepEqual(report.rows.map((r) => [r.action, r.outcome]), [
        ["keep", "names set"],
        ["keep", "names set"],
        ["remove", "removed"],
        ["keep", "no record"],
        ["hold", "action is not keep or remove"],
        ["remove", "not an email address"],
      ]);
      assert.deepEqual(report.counts, {
        "names set": 2, removed: 1, "no record": 1,
        "action is not keep or remove": 1, "not an email address": 1,
      });

      const pat = await getCustomer(stores, PAT);
      const sam = await getCustomer(stores, SAM);

      assert.equal(pat.name, "Pat Example");
      assert.equal(sam.name, "Sam Sample", "an empty cell keeps the name");
      assert.equal(await getCustomer(stores, LEE), null);
      assert.equal((await getOrder(stores, "NFF-1")).customer.deleted, true,
        "the order stays, re-pointed to the deleted household");
      assert.deepEqual(resend.contacts.map((c) => [c.email, c.first_name,
        c.last_name]), [[PAT, "Pat", "Example"], [SAM, "Sam", "Sample"]]);
      assert.equal(resend.calls.filter((c) => c.method === "DELETE").length,
        1);

      const printed = JSON.stringify(report);

      for (const address of [PAT, SAM, LEE, "nobody.here@example.com"]) {
        assert.ok(!leaks(printed, address), `summary: ${address}`);
        assert.ok(!lines.some((l) => leaks(l, address)), `log: ${address}`);
      }

      const forgotten = JSON.parse(lines.find((l) =>
        l.includes("customer.forgotten")));

      assert.equal(forgotten.record, maskEmail(LEE));
      assert.equal(forgotten.by, "james");
      assert.ok(lines.some((l) => l.includes("audience.applied")));
    });

  it("writes nothing on a dry run", async (t) => {
    const stores = await seed();
    const resend = resendFake([PAT, SAM, LEE]);
    const lines = capture(t);
    const report = await applyAudience(stores, parseCsv(CSV), {
      dryRun: true, env, fetchImpl: resend.fetchImpl, now, pace: 0,
    });

    assert.equal(report.dryRun, true);
    assert.equal(report.rows[0].outcome, "names set");
    assert.equal(report.rows[2].outcome, "removed");
    assert.equal((await getCustomer(stores, PAT)).lastName, "");
    assert.ok(await getCustomer(stores, LEE));
    assert.deepEqual(writes(resend.calls), []);
    assert.deepEqual(lines, []);
  });

  it("leaves a remove row with an order in progress, and goes on",
    async () => {
      const stores = await seed();
      const resend = resendFake([LEE, PAT]);

      await saveOrder(stores, {
        id: "NFF-2", status: "paid", submittedAt: "2026-10-20T12:00:00Z",
        customer: { email: LEE, name: "Lee" }, lines: [],
        totals: { total: 0 }, history: [],
      });

      const report = await applyAudience(stores, parseCsv(
        `action,email,first,last\nremove,${LEE},,\nkeep,${PAT},Pat,\n`), {
        env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      assert.deepEqual(report.rows.map((r) => r.outcome),
        ["not removed: an order is in progress", "names set"]);
      assert.ok(await getCustomer(stores, LEE));
    });
});

// James's reading on #496: after a sync, `customers delete` leaves the
// Resend contact, which the next sync takes back in as a sign-up;
// `customers forget --apply` (an `audience apply` remove row) deletes
// the contact, so the next sync adds nothing.
describe("a removal and the next sync", () => {
  it("customers delete leaves the contact, and the sync brings it back",
    async () => {
      const stores = testStores();
      const resend = resendFake([LEE]);

      await saveCustomer(stores, customer(LEE));
      await removeCustomer(stores, LEE);

      const synced = await syncAudience(stores, {
        env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      assert.deepEqual(synced.imported, [LEE]);
      assert.ok(await getCustomer(stores, LEE));
    });

  it("a remove row deletes the contact, and the sync adds nothing",
    async () => {
      const stores = testStores();
      const resend = resendFake([LEE]);

      await saveCustomer(stores, customer(LEE));
      await applyAudience(stores, parseCsv(
        `action,email,first,last\nremove,${LEE},,\n`), {
        env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      const synced = await syncAudience(stores, {
        env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      assert.deepEqual(synced.imported, []);
      assert.deepEqual(synced.created, []);
      assert.equal(await getCustomer(stores, LEE), null);
    });
});
