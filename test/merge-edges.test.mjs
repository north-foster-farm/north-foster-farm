// The implementer's own tests for #776's customers merge, beside the
// criteria in test/merge.test.mjs: what a merge does where both
// accounts hold the same thing, and the addresses it refuses. No
// outside service is configured, so Square and Resend are not reached.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { confirmed } from "../bin/confirm.mjs";
import { perksOf } from "../assets/scripts/order/lib/perks.mjs";
import { mergeCustomer } from "../netlify/functions/lib/admin.mjs";
import {
  creditKey, getLedger, grantCredit, mergeLedger,
} from "../netlify/functions/lib/credit.mjs";
import { auditLog } from "../netlify/functions/lib/group-log.mjs";
import {
  getGroupRecord, setGroupHost,
} from "../netlify/functions/lib/groups.mjs";
import { addPerk } from "../netlify/functions/lib/perks.mjs";
import {
  customerKey, getCustomer, saveCustomer, supportKey, supportPrefix,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-11-21T15:00:00Z");
const FROM = "pat+old@example.com";
const INTO = "pat@example.com";
const quiet = { env: {}, now, by: "tester" };
const failing = async () => {
  throw new Error("no network in this test");
};

// The store's delete of `key` throws the first time only, as a run
// that fails partway would.
const failOnce = (stores, key) => {
  const del = stores.customers.delete.bind(stores.customers);
  let armed = true;

  stores.customers.delete = async (k) => {
    if (armed && k === key) {
      armed = false;
      throw new Error("blobs down");
    }

    return del(k);
  };
};

const pair = async () => {
  const stores = testStores();

  await saveCustomer(stores, { email: FROM, name: "Old" });
  await saveCustomer(stores, { email: INTO, name: "Kept" });

  return stores;
};

describe("customers merge, where both accounts hold the same", () => {
  it("keeps both grants when their ids match", async () => {
    const stores = testStores();
    const from = { group: "vff", round: "2026-11-01", kind: "host" };

    await grantCredit(stores, FROM, { amount: 500, from, now,
      timeZone: "America/New_York" });
    await grantCredit(stores, INTO, { amount: 300, from, now,
      timeZone: "America/New_York" });

    assert.equal(await mergeLedger(stores, FROM, INTO), 1);
    assert.deepEqual((await getLedger(stores, INTO)).entries
      .map((e) => [e.id, e.amount]), [
      ["vff/2026-11-01/host", 300], ["vff/2026-11-01/host~merged", 500],
    ]);
    assert.deepEqual((await getLedger(stores, FROM)).entries, []);
  });

  it("does not double a perk the target already holds", async () => {
    const stores = await pair();

    await addPerk(stores, FROM, "free-delivery", { by: "cli", now });
    await addPerk(stores, INTO, "free-delivery", { by: "cli", now });

    const report = await mergeCustomer(stores, FROM, INTO, {
      ...quiet, apply: true, fetchImpl: failing,
    });

    assert.equal(report.perks, 0);
    assert.equal(perksOf(await getCustomer(stores, INTO)).length, 1);
  });

  it("keeps a help message whose id the target already holds", async () => {
    const stores = await pair();

    await stores.customers.set(supportKey(FROM, "m1"), { message: "Old" });
    await stores.customers.set(supportKey(INTO, "m1"), { message: "Kept" });
    await mergeCustomer(stores, FROM, INTO, {
      ...quiet, apply: true, fetchImpl: failing,
    });

    assert.deepEqual(await stores.customers.get(supportKey(INTO, "m1")),
      { message: "Kept" });
    assert.deepEqual(await stores.customers.get(supportKey(INTO, "m1~merged")),
      { message: "Old" });
  });

  it("moves no grant twice on a rerun after a failed delete", async () => {
    const stores = testStores();
    const from = { group: "vff", round: "2026-11-01", kind: "host" };
    const tz = { now, timeZone: "America/New_York" };

    await grantCredit(stores, FROM, { amount: 500, from, ...tz });
    await grantCredit(stores, INTO, { amount: 300, from, ...tz });

    const kept = await getLedger(stores, FROM);
    const sum = async () => (await getLedger(stores, INTO)).entries
      .reduce((s, e) => s + e.amount, 0);

    await mergeLedger(stores, FROM, INTO);
    // The source's delete failed: its ledger is still there.
    await stores.customers.set(creditKey(FROM), kept);
    assert.equal(await mergeLedger(stores, FROM, INTO), 0);
    assert.equal(await mergeLedger(stores, FROM, INTO), 0);
    assert.equal(await sum(), 800);
    assert.equal((await getLedger(stores, INTO)).entries.length, 2);
  });

  it("copies no perk or help message twice on a rerun", async () => {
    const stores = await pair();

    await addPerk(stores, FROM, "free-delivery", { by: "cli", end:
      "2026-11-21", now });
    await stores.customers.set(supportKey(FROM, "m1"), { message: "Old" });

    const later = new Date("2026-11-23T15:00:00Z");
    const run = () => mergeCustomer(stores, FROM, INTO, {
      ...quiet, now: later, apply: true, fetchImpl: failing,
    });

    // The last write, the source's record going, fails once.
    failOnce(stores, customerKey(FROM));
    await assert.rejects(run(), /blobs down/);
    await run();

    assert.equal(perksOf(await getCustomer(stores, INTO)).length, 1);
    assert.deepEqual((await stores.customers.list(supportPrefix(INTO)))
      .map((s) => s.key), [supportKey(INTO, "m1")]);
    assert.equal(await stores.customers.get(supportKey(INTO, "m1~merged")),
      null);
  });

  it("moves the host of a group to the target, logged", async () => {
    const stores = await pair();

    await setGroupHost(stores, "vff", FROM, { now });

    const dry = await mergeCustomer(stores, FROM, INTO, quiet);

    assert.deepEqual(dry.hostOf, ["vff"]);
    assert.equal((await getGroupRecord(stores, "vff")).host, FROM);

    const report = await mergeCustomer(stores, FROM, INTO, {
      ...quiet, apply: true, fetchImpl: failing,
    });

    assert.deepEqual(report.hostOf, ["vff"]);
    assert.equal((await getGroupRecord(stores, "vff")).host, INTO);
    assert.ok((await auditLog(stores, "vff"))
      .some((e) => e.action === "host.set"));
  });

  it("logs the membership the target's own group replaces", async () => {
    const stores = testStores();
    const member = { id: "vff", joinedAt: now.toISOString(), via: "farm" };

    await saveCustomer(stores, { email: FROM, memberGroup: member });
    await saveCustomer(stores, { email: INTO, memberGroup: member });

    const report = await mergeCustomer(stores, FROM, INTO, {
      ...quiet, apply: true, fetchImpl: failing,
    });

    assert.equal(report.groupDropped, "vff");
    assert.equal((await auditLog(stores, "vff"))
      .filter((e) => e.action === "member.remove").length, 1);
  });

  it("names both addresses in the production prompt, and which goes",
    async () => {
      const asked = [];
      const command = {
        group: "customers", action: "merge", rest: [FROM, INTO],
      };

      await confirmed(command, {
        context: "production", flags: { apply: true },
        ask: async (q) => { asked.push(q); return "no"; }, say: () => {},
      });
      assert.ok(asked[0].includes(`merge ${FROM} into ${INTO}, keeping ` +
        `${INTO} and removing ${FROM}`), asked[0]);

      const stores = await pair();
      const dry = await mergeCustomer(stores, FROM, INTO, quiet);

      assert.equal(dry.removed, FROM);
      assert.equal(dry.kept, INTO);
      assert.match(dry.summary, /is removed/);
    });

  it("refuses an address that isn't one, and the same address twice",
    async () => {
      const stores = await pair();

      await assert.rejects(mergeCustomer(stores, "pat", INTO, quiet),
        /isn't an email address/);
      await assert.rejects(mergeCustomer(stores, FROM, "a\u0007@b", quiet),
        /isn't an email address/);
      await assert.rejects(mergeCustomer(stores, FROM, ` ${FROM.toUpperCase()}`,
        quiet), /the same/);
      assert.ok(await getCustomer(stores, FROM));
    });
});

describe("customers merge, rerun after a failure (security, PR #780)",
  () => {
    const tz = { now, timeZone: "America/New_York" };
    const share = { group: "vff", round: "2026-11-01", kind: "share" };
    const later = new Date("2026-11-23T15:00:00Z");
    const sum = async (stores) => (await getLedger(stores, INTO)).entries
      .reduce((s, e) => s + e.amount, 0);

    it("keeps both of two members' equal shares of one round", async () => {
      const stores = await pair();

      await grantCredit(stores, FROM, { amount: 300, from: share, ...tz });
      await grantCredit(stores, INTO, { amount: 300, from: share, ...tz });

      const report = await mergeCustomer(stores, FROM, INTO, {
        ...quiet, apply: true, fetchImpl: failing,
      });

      assert.equal(report.credit, 1);
      assert.equal(await sum(stores), 600);
      assert.equal((await getLedger(stores, INTO)).entries.length, 2);
    });

    it("moves nothing twice when a run fails partway", async () => {
      for (const key of [creditKey(FROM), customerKey(FROM)]) {
        const stores = await pair();

        await grantCredit(stores, FROM, { amount: 300, from: share, ...tz });
        await grantCredit(stores, INTO, { amount: 300, from: share, ...tz });
        await addPerk(stores, FROM, "free-delivery", { by: "cli", end:
          "2026-11-21", now });
        await addPerk(stores, INTO, "free-delivery", { by: "cli", end:
          "2026-11-21", now });
        await stores.customers.set(supportKey(FROM, "m1"), { message: "Hi" });

        const run = () => mergeCustomer(stores, FROM, INTO, {
          ...quiet, now: later, apply: true, fetchImpl: failing,
        });

        failOnce(stores, key);
        await assert.rejects(run(), /blobs down/);
        await run();

        assert.equal(await sum(stores), 600, `failed at ${key}`);
        assert.equal(perksOf(await getCustomer(stores, INTO)).length, 2,
          `both ended perks are kept once each, failed at ${key}`);
        assert.deepEqual((await stores.customers.list(supportPrefix(INTO)))
          .map((s) => s.key), [supportKey(INTO, "m1")]);
        assert.equal(await getCustomer(stores, FROM), null);
      }
    });

    it("logs one member.remove across a rerun", async () => {
      const member = { id: "vff", joinedAt: now.toISOString(), via: "farm" };

      for (const keeps of [member, null]) {
        const stores = testStores();

        await saveCustomer(stores, { email: FROM, memberGroup: member });
        await saveCustomer(stores, { email: INTO,
          ...(keeps ? { memberGroup: keeps } : {}) });

        const run = () => mergeCustomer(stores, FROM, INTO, {
          ...quiet, apply: true, fetchImpl: failing,
        });

        failOnce(stores, customerKey(FROM));
        await assert.rejects(run(), /blobs down/);
        await run();

        const log = await auditLog(stores, "vff");

        assert.equal(log.filter((e) => e.action === "member.remove").length,
          1, keeps ? "the target keeps its group" : "the group moves");
        assert.equal(log.filter((e) => e.action === "member.add").length,
          keeps ? 0 : 1);
      }
    });
  });
