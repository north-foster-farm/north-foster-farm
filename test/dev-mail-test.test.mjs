import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { devMailTest } from "../netlify/functions/lib/admin.mjs";
import { MailError } from "../netlify/functions/lib/mail.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const env = {
  DEV_NOTIFICATIONS_EMAIL: "dev@x.test",
  ADMIN_EMAILS: "farm@x.test",
  MAIL_DRIVER: "resend",
  SITE_CONTEXT: "production",
};

const mailbox = () => {
  const sent = [];

  return { sent, mail: async (m) => sent.push(m) };
};

describe("bin/nff mail test-dev", () => {
  it("sends one message to the developer's address alone", async () => {
    const { sent, mail } = mailbox();
    const r = await devMailTest(testStores(), { env, mail });

    assert.deepEqual(r, {
      variable: "DEV_NOTIFICATIONS_EMAIL", count: 1, driver: "resend",
      delivered: true, error: null,
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["dev@x.test"]);
    assert.match(sent[0].subject, /^Developer notices test$/);
  });

  it("marks a staging test with its context", async () => {
    const { sent, mail } = mailbox();

    await devMailTest(testStores(), {
      env: { ...env, SITE_CONTEXT: "branch-deploy", MAIL_DRIVER: "outbox" },
      mail,
    });

    assert.match(sent[0].subject, /\(branch-deploy\)/);
  });

  it("does not fall back to the farm's address", async () => {
    const { sent, mail } = mailbox();
    const r = await devMailTest(testStores(), {
      env: { ...env, DEV_NOTIFICATIONS_EMAIL: "" }, mail,
    });

    assert.equal(r.delivered, false);
    assert.equal(r.error, "not set");
    assert.equal(sent.length, 0);
  });

  it("is not delivered by a driver that only logs", async () => {
    const { sent, mail } = mailbox();
    const r = await devMailTest(testStores(), {
      env: { ...env, MAIL_DRIVER: "" }, mail,
    });

    assert.equal(r.delivered, false);
    assert.equal(r.error, null);
    assert.equal(r.driver, "log");
    assert.equal(sent.length, 1);
  });

  it("reports a failure with a status and no address", async () => {
    const mail = async () => {
      throw new MailError("Resend refused dev@x.test", { status: 403 });
    };
    const r = await devMailTest(testStores(), { env, mail });

    assert.equal(r.delivered, false);
    assert.equal(r.error, "the mail service answered 403");
    assert.doesNotMatch(JSON.stringify(r), /x\.test/);
  });
});
