// Names set on a record and its Resend contact, and the batch cleanup
// of the imported list (#496): `customers set <email> first=.. last=..`
// and `audience apply <csv>`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAudience, removeCustomer, setNames,
} from "../netlify/functions/lib/admin.mjs";
import { forgetCustomer } from "../netlify/functions/lib/forget.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import {
  forgottenKey, parseApplyCsv, syncAudience,
} from "../netlify/functions/lib/news.mjs";
import {
  getCustomer, getOrder, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { newsWelcome } from "../netlify/functions/lib/templates.mjs";
import { resendFake } from "./resend-fixture.mjs";

const now = new Date("2026-10-27T12:00:00Z");
const env = {
  SITE_URL: "https://northfosterfarm.com",
  RESEND_AUDIENCE_ID: "aud", RESEND_API_KEY: "k",
};
const PAT = "pat.example@gmail.test";
const SAM = "sam.sample@example.org";
const LEE = "lee.duplicate@example.net";

/* eslint-disable camelcase -- Resend names contact fields its way */

const writes = (calls) => calls.filter((c) => c.method !== "GET")
  .map(({ method, pathname, body }) => ({ method, pathname, body }));

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

  it("keeps the record's change for a contact gone from Resend since " +
    "the listing", async () => {
    const stores = testStores();
    const resend = resendFake([]);

    await saveCustomer(stores, customer(PAT));

    // Listed by the caller, then deleted in Resend: the rename is a 404.
    const report = await setNames(stores, PAT, { first: "Pat" }, {
      env, fetchImpl: resend.fetchImpl, contacts: [{ email: PAT }],
    });

    assert.equal((await getCustomer(stores, PAT)).firstName, "Pat");
    assert.match(report.resend,
      /^not reached: Resend 404 on PATCH .*: Contact not found$/);
    assert.ok(!leaks(report.resend, PAT));
  });

  // Resend's 500 can't be recorded on demand: this one is injected.
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
      const report = await applyAudience(stores, parseApplyCsv(CSV), {
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
      assert.deepEqual([sam.firstName, sam.lastName, sam.name],
        ["", "Sample", "Sample"], "an empty cell sets that name blank");
      assert.equal(await getCustomer(stores, LEE), null);
      assert.equal((await getOrder(stores, "NFF-1")).customer.deleted, true,
        "the order stays, re-pointed to the deleted household");
      assert.deepEqual(resend.contacts.map((c) => [c.email, c.first_name,
        c.last_name]), [[PAT, "Pat", "Example"], [SAM, "", "Sample"]]);
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
    const report = await applyAudience(stores, parseApplyCsv(CSV), {
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

      const report = await applyAudience(stores, parseApplyCsv(
        `action,email,first,last\nremove,${LEE},,\nkeep,${PAT},Pat,\n`), {
        env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      assert.deepEqual(report.rows.map((r) => r.outcome),
        ["not removed: an order is in progress", "names set"]);
      assert.ok(await getCustomer(stores, LEE));
    });

  // James, comment 6453653919: a blank or initial last name and an
  // empty first name are valid, with no warning, and the note column
  // is his alone.
  it("sets each name as given, ignores the note, and warns of nothing",
    async (t) => {
      const stores = testStores();
      const resend = resendFake([PAT, SAM, LEE]);

      await saveCustomer(stores, customer(PAT, "Pat", "Example"));
      await saveCustomer(stores, customer(SAM, "Sam", "Sample"));
      await saveCustomer(stores, customer(LEE, "Lee", "Duplicate"));

      const warn = t.mock.method(console, "warn", () => {});

      t.mock.method(console, "log", () => {});
      t.mock.method(console, "info", () => {});

      const rows = parseApplyCsv("Action,Email,First,Last,Note\n"
        + `keep,${PAT},Pat,E,"met at the market, July"\n`
        + `keep,${SAM},,Sample,no first name on the sheet\n`
        + `keep,${LEE},Lee,,\n`);

      assert.deepEqual(rows.map((r) => [r.firstName, r.lastName]),
        [["Pat", "E"], ["", "Sample"], ["Lee", ""]]);
      assert.ok(rows.every((r) => !("note" in r)));

      const report = await applyAudience(stores, rows, {
        by: "james", env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      assert.deepEqual(report.rows.map((r) => r.outcome),
        ["names set", "names set", "names set"]);

      const names = async (email) => {
        const c = await getCustomer(stores, email);

        return [c.firstName, c.lastName, c.name];
      };

      assert.deepEqual(await names(PAT), ["Pat", "E", "Pat E"]);
      assert.deepEqual(await names(SAM), ["", "Sample", "Sample"]);
      assert.deepEqual(await names(LEE), ["Lee", "", "Lee"]);
      assert.deepEqual(resend.contacts.map((c) => [c.first_name,
        c.last_name]), [["Pat", "E"], ["", "Sample"], ["Lee", ""]]);
      assert.equal(warn.mock.callCount(), 0);
    });

  it("needs action, email, first and last in the header", () => {
    assert.throws(() => parseApplyCsv(`action,email,first\nkeep,${PAT},Pat\n`),
      /no last column/);
    assert.throws(() => parseApplyCsv(`action,email\nremove,${LEE}\n`),
      /no first or last column/);
    assert.throws(() => parseApplyCsv(`keep,${PAT},Pat,Example\n`),
      /header needs action,email,first,last/);
    assert.deepEqual(parseApplyCsv(
      `last,first,email,action\nE,Pat,${PAT},keep\n`,
    ), [{ action: "keep", email: PAT, firstName: "Pat", lastName: "E" }]);
  });
});

describe("the welcome's greeting", () => {
  const hi = (who) => newsWelcome(who, "u", {}).text.trim().split("\n")[0];

  it("greets by the first name alone, never the last", () => {
    assert.equal(hi({ firstName: "Pat", lastName: "Example",
      name: "Pat Example" }), "Hi Pat,");
    assert.equal(hi({ firstName: "", lastName: "Sample", name: "Sample" }),
      "Hi,");
    assert.equal(hi({ lastName: "Sample", name: "Sample" }), "Hi,");
  });

  it("takes the first word of name only when there is neither", () => {
    assert.equal(hi({ name: "Pat Example" }), "Hi Pat,");
    assert.equal(hi({ firstName: "", lastName: "", name: "" }), "Hi,");
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
      await applyAudience(stores, parseApplyCsv(
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

// Resend answers a delete of a contact that isn't there with 200 and
// deleted true, as for one that is (test/fixtures/resend/
// contacts-delete-missing.json). A contact deleted in Resend between
// the listing and the delete is then removed all the same, with no
// marker left for the sync.
describe("a contact already gone from Resend", () => {
  // The audience lists `email`, which is deleted there right after.
  const vanishing = (resend, email) => async (url, init = {}) => {
    const res = await resend.fetchImpl(url, init);

    if ((init.method || "GET") === "GET") {
      resend.contacts.splice(
        resend.contacts.findIndex((c) => c.email === email), 1);
    }

    return res;
  };
  // Each DELETE's status and answer.
  const watched = (resend) => {
    const answers = [];

    return {
      answers,
      fetchImpl: async (url, init = {}) => {
        const res = await resend.fetchImpl(url, init);

        if (init.method === "DELETE") {
          answers.push([res.status, await res.clone().json()]);
        }

        return res;
      },
    };
  };

  it("forget --apply counts it removed, and leaves no marker", async () => {
    const stores = testStores();
    const resend = resendFake([LEE]);
    const seen = watched({ fetchImpl: vanishing(resend, LEE) });

    await saveCustomer(stores, customer(LEE));

    const r = await forgetCustomer(stores, LEE, {
      apply: true, env, fetchImpl: seen.fetchImpl, now, by: "james",
    });

    assert.equal(r.ok, true);
    assert.equal(r.resend, "removed");
    assert.deepEqual(seen.answers, [[200, {
      object: "contact", contact: LEE, deleted: true,
    }]]);
    assert.equal(await getCustomer(stores, LEE), null);
    assert.equal(await stores.customers.get(forgottenKey(LEE)), null);
  });

  it("an audience apply remove row is removed, and the sync adds nothing",
    async () => {
      const stores = testStores();
      const resend = resendFake([LEE, PAT]);
      const seen = watched({ fetchImpl: vanishing(resend, LEE) });

      await saveCustomer(stores, customer(LEE));

      const report = await applyAudience(stores, parseApplyCsv(
        `action,email,first,last\nremove,${LEE},,\n`), {
        env, fetchImpl: seen.fetchImpl, now, pace: 0,
      });

      assert.deepEqual(report.rows.map((r) => [r.outcome, r.resend]),
        [["removed", "removed"]]);
      assert.deepEqual(seen.answers.map(([status, body]) =>
        [status, body.deleted]), [[200, true]]);
      assert.equal(await stores.customers.get(forgottenKey(LEE)), null);

      const synced = await syncAudience(stores, {
        env, fetchImpl: resend.fetchImpl, now, pace: 0,
      });

      assert.deepEqual([synced.created, synced.forgotten], [[], []]);
      assert.equal(await getCustomer(stores, LEE), null);
    });

  it("the sync clears a marker whose contact is already gone", async () => {
    const stores = testStores();
    const resend = resendFake([LEE]);

    await stores.customers.set(forgottenKey(LEE), { at: now.toISOString() });

    const synced = await syncAudience(stores, {
      env, fetchImpl: vanishing(resend, LEE), now, pace: 0,
    });

    assert.deepEqual(synced.forgotten, [LEE]);
    assert.equal(await stores.customers.get(forgottenKey(LEE)), null);
    assert.equal(await getCustomer(stores, LEE), null);
  });

  it("forget finds no contact to delete when none is listed", async () => {
    const stores = testStores();
    const resend = resendFake([PAT]);

    await saveCustomer(stores, customer(LEE));

    const r = await forgetCustomer(stores, LEE, {
      apply: true, env, fetchImpl: resend.fetchImpl, now,
    });

    assert.equal(r.resend, "none");
    assert.deepEqual(writes(resend.calls), []);
  });
});

// The recorded list answers the whole audience with has_more false. One
// with has_more is part of it, and nothing acts on part.
describe("a list answer with has_more", () => {
  it("stops the sync before it writes", async () => {
    const stores = testStores();
    const resend = resendFake([PAT], { more: true });

    await saveCustomer(stores, customer(SAM));
    await assert.rejects(syncAudience(stores, {
      env, fetchImpl: resend.fetchImpl, now, pace: 0,
    }), /listed only part of the audience/);
    assert.deepEqual(writes(resend.calls), []);
  });

  it("leaves forget's marker for the sync, as when Resend is down",
    async () => {
      const stores = testStores();
      const resend = resendFake([LEE], { more: true });

      await saveCustomer(stores, customer(LEE));

      const r = await forgetCustomer(stores, LEE, {
        apply: true, env, fetchImpl: resend.fetchImpl, now,
      });

      assert.match(r.resend, /^not reached: .*part of the audience/);
      assert.ok(await stores.customers.get(forgottenKey(LEE)));
      assert.deepEqual(writes(resend.calls), []);
    });
});
