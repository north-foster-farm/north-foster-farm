// A production log line that names a customer carries the address
// masked, never in full (James, #496): lib/mask.mjs, and the lines
// `audience remove` and `customers delete` write.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { removeCustomer } from "../netlify/functions/lib/admin.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import {
  importSubscribers, removeImported,
} from "../netlify/functions/lib/news.mjs";
import { saveCustomer } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-01T12:00:00Z");
const env = { SITE_URL: "https://northfosterfarm.com" };

const capture = (t) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }

  return lines;
};

describe("maskEmail", () => {
  it("keeps three at each end of each part", () => {
    assert.equal(maskEmail("abcdefgh@example.com"), "abc**fgh@exa*****com");
    assert.equal(maskEmail(" Pat.Example@Gmail.test "),
      "pat*****ple@gma****est");
    assert.equal(maskEmail("abcdefg@mail.example.org"),
      "abc*efg@mai**********org");
  });

  it("masks a part of six or fewer in full", () => {
    assert.equal(maskEmail("pat@farm.co"), "***@far*.co");
    assert.equal(maskEmail("abcdef@abc.de"), "******@******");
    assert.equal(maskEmail("a@b.co"), "*@****");
  });

  it("masks something that is not an address", () => {
    assert.equal(maskEmail("abcdefgh"), "abc**fgh");
    assert.equal(maskEmail(""), "");
  });
});

describe("log lines that name a customer", () => {
  const ADDRESSES = [
    "abcdefgh@example.com", "pat.example@gmail.test", "a@b.co",
  ];
  const leaks = (lines, address) => {
    const [local, domain] = address.split("@");

    return lines.filter((l) => l.toLowerCase().includes(address)
      || (local.length > 6 && l.includes(local))
      || (domain.length > 6 && l.includes(domain)));
  };

  it("audience remove logs the address masked, deleted or cleared",
    async (t) => {
      const stores = testStores();

      await importSubscribers(stores,
        ADDRESSES.map((email) => ({ email })),
        { date: "2024-07-12", now, env, skip: true });
      await stores.orders.set("order/NFF-1", { id: "NFF-1" });
      await stores.orders.set(`by-email/${ADDRESSES[1]}/NFF-1`,
        { id: "NFF-1" });

      const lines = capture(t);

      for (const email of ADDRESSES) {
        await removeImported(stores, email, { by: "james", now });
      }

      const removed = lines.filter((l) => l.includes("news.removed"));

      assert.equal(removed.length, ADDRESSES.length);
      ADDRESSES.forEach((email, i) => {
        const record = JSON.parse(removed[i]);

        assert.equal(record.record, maskEmail(email));
        assert.equal(record.by, "james");
        assert.ok(record._time);
        assert.equal(record.outcome, i === 1 ? "cleared" : "deleted");
        assert.deepEqual(leaks(lines, email), [], email);
      });
    });

  it("customers delete logs the address masked", async (t) => {
    const stores = testStores();
    const email = ADDRESSES[1];

    await saveCustomer(stores, {
      email, name: "Pat Example", phone: "", avatar: null,
      discountGroup: null, address: null,
    });

    const lines = capture(t);

    await removeCustomer(stores, "Pat.Example@Gmail.test", { by: "james" });

    const record = JSON.parse(lines.find((l) =>
      l.includes("customer.deleted")));

    assert.equal(record.record, "pat*****ple@gma****est");
    assert.equal(record.outcome, "deleted");
    assert.equal(record.by, "james");
    assert.ok(record._time);
    assert.deepEqual(leaks(lines, email), []);
  });
});
