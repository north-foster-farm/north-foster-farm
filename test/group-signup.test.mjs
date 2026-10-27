// Joining a buying group (#495, part 2): typing the code again changes
// nothing and says so, and another group's code never moves a
// membership.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle as lookup } from "../netlify/functions/group.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  joinGroup, memberKeyOf, setGroupCode,
} from "../netlify/functions/lib/groups.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-11-02", 9, 0, "America/New_York");
const later = instant("2026-11-20", 9, 0, "America/New_York");
const env = { URL: "https://x", PICKUP_SCHEDULE: SCHEDULE };
const CODE = "GYM-2026";
const EMAIL = "pat@example.com";

const ask = (body, stores, headers = {}) => lookup(
  new Request("http://x/api/group", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), { stores, now, ip: "1.2.3.4", env });

const setup = async () => {
  const stores = testStores();

  await setGroupCode(stores, "vff", { code: CODE, now });
  const session = await createSession(stores, EMAIL, { now });

  return { stores, cookie: { cookie: `nff_session=${session.id}` } };
};

describe("the same code again (edge 1)", () => {
  it("tells a signed-in member they are in already", async () => {
    const { stores, cookie } = await setup();

    const first = await (await ask({ code: CODE }, stores, cookie)).json();

    assert.equal(first.already, false);

    await joinGroup(stores, EMAIL, "vff", { now, via: "code" });

    const again = await (await ask({ code: CODE }, stores, cookie)).json();

    assert.equal(again.ok, true);
    assert.equal(again.already, true);
    // Not signed in, the page can't know, and says the usual.
    assert.equal((await (await ask({ code: CODE }, stores)).json()).already,
      false);
  });

  it("keeps the first join's date and path", async () => {
    const { stores } = await setup();

    await joinGroup(stores, EMAIL, "vff", { now, via: "code" });
    await joinGroup(stores, EMAIL, "vff", { now: later, via: "farm" });

    const { memberGroup } = await getCustomer(stores, EMAIL);

    assert.deepEqual(memberGroup, {
      id: "vff", joinedAt: now.toISOString(), via: "code",
    });
  });
});

describe("another group's code (edge 2)", () => {
  it("never moves a membership", async () => {
    const { stores } = await setup();
    const customer = await getCustomer(stores, EMAIL);
    const elsewhere = { id: "other", joinedAt: now.toISOString(), via: "code" };

    await saveCustomer(stores, { ...customer, memberGroup: elsewhere });
    await joinGroup(stores, EMAIL, "vff", { now: later, via: "code" });

    const after = await getCustomer(stores, EMAIL);

    assert.equal(memberKeyOf(after), "other");
    assert.deepEqual(after.memberGroup, elsewhere);
  });

  it("still unlocks the group for that order", async () => {
    const { stores, cookie } = await setup();
    const customer = await getCustomer(stores, EMAIL);

    await saveCustomer(stores, {
      ...customer,
      memberGroup: { id: "other", joinedAt: now.toISOString(), via: "code" },
    });

    const data = await (await ask({ code: CODE }, stores, cookie)).json();

    assert.equal(data.group.key, "vff");
    assert.equal(data.already, false);
    // So the page asks them nothing: they won't join (decision 5).
    assert.equal(data.elsewhere, true);
  });

  it("is not elsewhere for someone in no group, or in this one",
    async () => {
      const { stores, cookie } = await setup();

      assert.equal((await (await ask({ code: CODE }, stores, cookie))
        .json()).elsewhere, false);
      await joinGroup(stores, EMAIL, "vff", { now, via: "code" });
      assert.equal((await (await ask({ code: CODE }, stores, cookie))
        .json()).elsewhere, false);
    });
});
