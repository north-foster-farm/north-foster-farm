import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { endAllSessions } from "../netlify/functions/lib/admin.mjs";
import { sessionKey } from "../netlify/functions/lib/auth.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const env = {
  ADMIN_EMAILS: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  SITE_CONTEXT: "staging",
};

const seed = async (stores) => {
  for (const id of ["a", "b", "c"]) {
    await stores.auth.set(sessionKey(id), { email: `${id}@x.com` });
  }
  await stores.auth.set("token/keep", { email: "a@x.com" });
};

const mailbox = () => {
  const sent = [];

  return { sent, mail: async (m) => sent.push(m) };
};

describe("endAllSessions", () => {
  it("counts and changes nothing without apply", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await seed(stores);

    const r = await endAllSessions(stores, { env, mail });

    assert.deepEqual(r, { count: 3, ended: false });
    assert.equal((await stores.auth.list("session/")).length, 3);
    assert.equal(sent.length, 0);
  });

  it("deletes every session, spares the rest, emails the dev", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await seed(stores);

    const r = await endAllSessions(stores, { apply: true, env, mail });

    assert.deepEqual(r, { count: 3, ended: true, notified: true });
    assert.equal((await stores.auth.list("session/")).length, 0);
    assert.ok(await stores.auth.get("token/keep"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to.join(), "dev@x.com");
    assert.match(sent[0].subject, /Every session was ended \(staging\)/);
  });

  it("falls back to the farm's address", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await endAllSessions(stores, {
      apply: true, env: { ADMIN_EMAILS: "farm@x.com" }, mail,
    });
    assert.equal(sent[0].to.join(), "farm@x.com");
  });

  it("ends nothing quietly when no one is signed in", async () => {
    const stores = testStores();
    const { mail } = mailbox();
    const r = await endAllSessions(stores, { apply: true, env, mail });

    assert.equal(r.count, 0);
  });
});
