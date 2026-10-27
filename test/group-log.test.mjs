// A buying group's join log and audit log (#495, part 3): a join is
// logged once, with its path; members from before are backfilled; an
// act is one append-only record; deleting a customer's details takes
// their address off both.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setCustomer } from "../netlify/functions/lib/admin.mjs";
import { forgetCustomer } from "../netlify/functions/lib/forget.mjs";
import {
  JOIN_PATHS, audit, auditLog, backfillJoins, groupMembers, joinLog,
} from "../netlify/functions/lib/group-log.mjs";
import { joinGroup } from "../netlify/functions/lib/groups.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-11-02T14:00:00Z");
const later = new Date("2026-11-09T14:00:00Z");
const PAT = "pat@example.com";
const SAM = "sam@example.com";

const person = (email, first, last, extra = {}) => ({
  email, firstName: first, lastName: last, name: `${first} ${last}`,
  phone: "", createdAt: now.toISOString(), ...extra,
});

const withPeople = async () => {
  const stores = testStores();

  await saveCustomer(stores, person(PAT, "Pat", "Example"));
  await saveCustomer(stores, person(SAM, "Sam", "Sample"));

  return stores;
};

const news = { removeContact: async () => "removed" };

describe("the join log", () => {
  it("names every path a member can come by", () => {
    assert.deepEqual(JOIN_PATHS,
      ["code", "link", "qr", "walk-in", "farm", "host", "invite"]);
  });

  it("is written on the first join only, with its path", async () => {
    const stores = await withPeople();

    await joinGroup(stores, PAT, "vff", { now, via: "link" });
    await joinGroup(stores, PAT, "vff", { now: later, via: "code" });

    const log = await joinLog(stores, "vff");

    assert.equal(log.length, 1);
    assert.deepEqual(log[0], {
      group: "vff", email: PAT, at: now.toISOString(), via: "link",
      event: "join",
    });
  });

  it("logs another group's code as refused", async () => {
    const stores = await withPeople();
    const pat = await getCustomer(stores, PAT);

    await saveCustomer(stores, { ...pat, memberGroup: {
      id: "other", joinedAt: now.toISOString(), via: "code" } });
    await joinGroup(stores, PAT, "vff", { now: later, via: "code" });

    const [line] = await joinLog(stores, "vff");

    assert.equal(line.event, "switch-refused");
    assert.equal(line.member, "other");
    assert.deepEqual(await groupMembers(stores, "vff"), []);
  });

  it("backfills the members from before it, once", async () => {
    const stores = await withPeople();
    const pat = await getCustomer(stores, PAT);

    // Joined before the log existed: the record says so, the log not.
    await saveCustomer(stores, { ...pat, memberGroup: {
      id: "vff", joinedAt: now.toISOString(), via: "code" } });
    await joinGroup(stores, SAM, "vff", { now: later, via: "walk-in" });

    assert.deepEqual((await backfillJoins(stores, "vff")).map((m) => m.email),
      [PAT]);
    assert.equal((await joinLog(stores, "vff")).length, 1, "a dry run");

    await backfillJoins(stores, "vff", { apply: true });
    await backfillJoins(stores, "vff", { apply: true });

    const log = await joinLog(stores, "vff");

    assert.deepEqual(log.map((j) => [j.email, j.via, !!j.backfilled]),
      [[PAT, "code", true], [SAM, "walk-in", false]]);
    assert.equal(log[0].at, now.toISOString());
  });

  it("lists the members with name, address, date joined and path",
    async () => {
      const stores = await withPeople();

      await joinGroup(stores, SAM, "vff", { now: later, via: "qr" });
      await joinGroup(stores, PAT, "vff", { now, via: "code" });

      const list = await groupMembers(stores, "vff");

      assert.deepEqual(list.map((m) => [m.email, m.name, m.joinedAt, m.via]),
        [[PAT, "Pat Example", now.toISOString(), "code"],
          [SAM, "Sam Sample", later.toISOString(), "qr"]]);
    });
});

describe("the audit log", () => {
  it("keeps one record per act: who, what, to whom, before, after",
    async () => {
      const stores = testStores();

      await audit(stores, { group: "vff", by: { role: "host", email: SAM },
        action: "member.remove", target: PAT, before: { group: "vff" },
        after: { group: null }, now });
      await audit(stores, { group: "vff", by: { role: "farm" },
        action: "qr.rotate", now: later });

      const log = await auditLog(stores, "vff");

      assert.deepEqual(log[0], {
        group: "vff", at: now.toISOString(),
        by: { role: "host", email: SAM }, action: "member.remove",
        target: PAT, before: { group: "vff" }, after: { group: null },
      });
      assert.deepEqual(log[1].by, { role: "farm" });
    });

  it("refuses an actor it does not know", async () => {
    await assert.rejects(audit(testStores(), {
      group: "vff", by: { role: "stranger" }, action: "x",
    }), /Who acted/);
  });

  it("records the farm moving a member by customers set", async () => {
    const stores = await withPeople();

    await setCustomer(stores, PAT, { member: "vff" });
    await setCustomer(stores, PAT, { member: "vff" });
    await setCustomer(stores, PAT, { member: "none" });

    const acts = await auditLog(stores, "vff");

    assert.deepEqual(acts.map((a) => [a.by.role, a.action, a.target]),
      [["farm", "member.add", PAT], ["farm", "member.remove", PAT]]);
    assert.deepEqual((await joinLog(stores, "vff")).map((j) => j.via),
      ["farm"]);
  });
});

describe("deleting a customer's details", () => {
  it("takes their address off both logs and keeps the acts", async () => {
    const stores = await withPeople();

    await joinGroup(stores, PAT, "vff", { now, via: "code" });
    await audit(stores, { group: "vff", by: { role: "host", email: SAM },
      action: "member.remove", target: PAT, now });
    await audit(stores, { group: "vff", by: { role: "farm" },
      action: "host.set", target: PAT, before: { host: null },
      after: { host: PAT }, now: later });

    const dry = await forgetCustomer(stores, PAT, { news, now });

    assert.equal(dry.groupLogs, 3);

    await forgetCustomer(stores, PAT, { news, now, apply: true });

    const text = JSON.stringify([
      ...(await joinLog(stores, "vff")), ...(await auditLog(stores, "vff")),
    ]);

    assert.ok(!text.includes(PAT), text);
    assert.ok(text.includes(SAM), "another person's address stays");
    assert.equal((await auditLog(stores, "vff")).length, 2);
  });
});
