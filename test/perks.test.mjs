// Customer perks on the record (#514): `bin/nff perks add`, `list` and
// `remove`, each change logged with the address masked and no name.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activePerks, perkEffects, perkSentence,
} from "../assets/scripts/order/lib/perks.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import {
  addPerk, listPerks, perkTypes, removePerk,
} from "../netlify/functions/lib/perks.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-29T16:00:00Z");
const PAT = "pat.example@gmail.test";

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

const pat = () => ({
  email: PAT, firstName: "Pat", lastName: "Example", name: "Pat Example",
  phone: "4015550100", avatar: null, discountGroup: null, address: null,
  marketing: false, marketingAt: null, createdAt: "2026-01-02T12:00:00.000Z",
});

describe("perks add", () => {
  it("stores the type, start, end and who set it, and logs it masked",
    async (t) => {
      const stores = testStores();

      await saveCustomer(stores, pat());

      const lines = capture(t);
      const r = await addPerk(stores, "Pat.Example@Gmail.test",
        "free-delivery", { end: "2027-12-31", by: "james", now });
      const saved = await getCustomer(stores, PAT);

      assert.equal(r.made, false);
      assert.deepEqual(saved.perks, [{
        type: "free-delivery", start: "2026-10-29", end: "2027-12-31",
        setBy: "james", setAt: now.toISOString(),
      }]);
      assert.equal(saved.firstName, "Pat", "the rest of the record stays");

      const line = JSON.parse(lines.find((l) => l.includes("perk.added")));

      assert.equal(line.record, maskEmail(PAT));
      assert.equal(line.by, "james");
      assert.equal(line.type, "free-delivery");
      assert.deepEqual(line.before, []);
      assert.deepEqual(line.after, ["free-delivery"]);
      assert.ok(line._time);
      assert.ok(!lines.some((l) => l.includes(PAT)), "no full address");
      assert.ok(!lines.some((l) => l.includes("Example")), "no name");
    });

  it("makes the record of a customer who has never ordered online",
    async (t) => {
      const stores = testStores();
      const lines = capture(t);
      const r = await addPerk(stores, PAT, "friends", { by: "james", now });
      const saved = await getCustomer(stores, PAT);

      assert.equal(r.made, true);
      assert.equal(saved.email, PAT);
      assert.equal(saved.marketing, false);
      assert.equal(saved.perks[0].type, "friends");
      assert.equal(saved.perks[0].end, null);
      assert.ok(lines.some((l) => l.includes("\"madeRecord\":true")));
    });

  it("sets family only for James, with --owner", async (t) => {
    const stores = testStores();

    capture(t);
    await assert.rejects(addPerk(stores, PAT, "family", { now }),
      /Only James sets the family perk/);
    assert.equal(await getCustomer(stores, PAT), null, "nothing written");

    await addPerk(stores, PAT, "family", { owner: true, by: "james", now });
    assert.deepEqual(perkTypes(await getCustomer(stores, PAT), now),
      ["family"]);
  });

  it("refuses an unknown type, a bad date, an end before the start and " +
    "a type already held", async (t) => {
    const stores = testStores();

    capture(t);
    await assert.rejects(addPerk(stores, PAT, "free-eggs", { now }),
      /Unknown perk "free-eggs"/);
    await assert.rejects(addPerk(stores, PAT, "free-delivery",
      { end: "12/31/2027", now }), /--end is a date/);
    await assert.rejects(addPerk(stores, PAT, "free-delivery",
      { end: "2026-10-01", now }), /--end is before the start/);
    await assert.rejects(addPerk(stores, "not-an-address", "friends",
      { now }), /Give an email address/);

    await addPerk(stores, PAT, "free-delivery", { now });
    await assert.rejects(addPerk(stores, PAT, "free-delivery", { now }),
      /already holds free-delivery/);
    // A different type is a second perk.
    await addPerk(stores, PAT, "minimum-waived", { now });
    assert.deepEqual(perkTypes(await getCustomer(stores, PAT), now).sort(),
      ["free-delivery", "minimum-waived"]);
  });
});

describe("perks remove", () => {
  it("dates the perk removed, which stops it at once, and logs it",
    async (t) => {
      const stores = testStores();

      await saveCustomer(stores, pat());
      capture(t);
      await addPerk(stores, PAT, "friends", { by: "james", now });

      const lines = capture(t);
      const later = new Date("2026-11-02T15:00:00Z");

      await removePerk(stores, PAT, "friends", { by: "james", now: later });

      const saved = await getCustomer(stores, PAT);

      assert.equal(saved.perks.length, 1, "kept on the record");
      assert.equal(saved.perks[0].removedAt, later.toISOString());
      assert.equal(saved.perks[0].removedBy, "james");
      assert.deepEqual(perkTypes(saved, later), []);

      const line = JSON.parse(lines.find((l) => l.includes("perk.removed")));

      assert.equal(line.record, maskEmail(PAT));
      assert.deepEqual(line.before, ["friends"]);
      assert.deepEqual(line.after, []);
      assert.ok(!lines.some((l) => l.includes(PAT) || l.includes("Pat ")));

      // Once removed, it may be granted again.
      await addPerk(stores, PAT, "friends", { now: later });
      assert.deepEqual(perkTypes(await getCustomer(stores, PAT), later),
        ["friends"]);
    });

  it("refuses a perk the customer does not hold", async (t) => {
    const stores = testStores();

    capture(t);
    await assert.rejects(removePerk(stores, PAT, "friends", { now }),
      /No such customer/);
    await saveCustomer(stores, pat());
    await assert.rejects(removePerk(stores, PAT, "friends", { now }),
      /holds no friends perk/);
  });
});

describe("a perk's dates", () => {
  it("applies from its start through its end day, in the farm's zone, " +
    "with no step to end it", async (t) => {
    const stores = testStores();

    capture(t);
    await addPerk(stores, PAT, "free-delivery", {
      start: "2026-11-01", end: "2026-11-30", now,
    });

    const c = await getCustomer(stores, PAT);
    // 11 pm on November 30 in Rhode Island is December 1 in UTC.
    const lastEvening = new Date("2026-12-01T04:00:00Z");
    const after = new Date("2026-12-01T05:30:00Z");

    assert.deepEqual(perkTypes(c, now), [], "not yet");
    assert.deepEqual(perkTypes(c, new Date("2026-11-01T12:00:00Z")),
      ["free-delivery"]);
    assert.deepEqual(perkTypes(c, lastEvening), ["free-delivery"]);
    assert.deepEqual(perkTypes(c, after), [], "expired by itself");

    const states = (await listPerks(stores, { now: after }))
      .map((p) => p.state);

    assert.deepEqual(states, ["ended"]);
    assert.deepEqual((await listPerks(stores, { email: PAT, now }))
      .map((p) => p.state), ["future"]);
  });

  it("reads one active perk per type, and what they lift", () => {
    const c = { perks: [
      { type: "free-delivery", start: "2026-01-01", end: null },
      { type: "free-delivery", start: "2026-02-01", end: null },
      { type: "friends", start: "2026-01-01", end: "2026-03-01",
        removedAt: "2026-02-01T00:00:00.000Z" },
      { type: "minimum-waived", start: "2026-01-01" },
    ] };

    assert.deepEqual(activePerks(c, "2026-02-15").map((p) => p.type),
      ["free-delivery", "minimum-waived"]);
    assert.deepEqual(perkEffects(["free-delivery"]), {
      types: ["free-delivery"], fee: true, minimum: false, friends: false,
      family: false,
    });
    assert.deepEqual(perkEffects(["friends", "bogus"]), {
      types: ["friends"], fee: true, minimum: true, friends: true,
      family: false,
    });
    assert.equal(perkEffects(["family"]).family, true);
  });
});

describe("perk wording (drafts)", () => {
  it("says the end date, or nothing for an open perk", () => {
    assert.equal(perkSentence({ type: "free-delivery", end: "2027-12-31" }),
      "Free delivery through the end of 2027.");
    assert.equal(perkSentence({ type: "free-delivery", end: null }),
      "Free delivery.");
    assert.equal(perkSentence({ type: "minimum-waived", end: "2027-03-03" }),
      "No delivery minimum through March 3, 2027.");
  });
});
