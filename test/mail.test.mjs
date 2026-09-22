import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adminEmails, mailConfigured, sendMail,
} from "../netlify/functions/lib/mail.mjs";

const live = {
  MAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_test",
  MAIL_FROM: "North Foster Farm <orders@example.com>",
  MAIL_REPLY_TO: "sales@example.com",
};

const message = {
  to: "pat@example.com", subject: "Hi", text: "hello", html: "<p>hello</p>",
  idempotencyKey: "k-1",
};

describe("mail configuration", () => {
  it("is off unless the driver, key and sender are all set", () => {
    assert.equal(mailConfigured({}), false);
    assert.equal(mailConfigured({ MAIL_DRIVER: "resend" }), false);
    assert.equal(mailConfigured({ ...live, MAIL_FROM: "" }), false);
    assert.equal(mailConfigured(live), true);
  });

  it("splits the admin list", () => {
    assert.deepEqual(adminEmails({ ADMIN_EMAILS: " a@x.com, b@x.com ,, " }),
      ["a@x.com", "b@x.com"]);
    assert.deepEqual(adminEmails({}), []);
  });
});

describe("sendMail", () => {
  it("logs instead of sending when not configured", async () => {
    const calls = [];
    const fetchImpl = async () => { calls.push(1); };
    const out = await sendMail(message, { env: {}, fetchImpl });

    assert.equal(out.driver, "log");
    assert.equal(calls.length, 0);
  });

  it("writes the message to files under MAIL_OUT with the file driver",
    async () => {
      const {
        mkdtempSync, readdirSync, readFileSync,
      } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "nff-outbox-"));
      const calls = [];
      const fetchImpl = async () => { calls.push(1); };
      const out = await sendMail({
        ...message, html: "<p>hello</p>", subject: "Hi there: order X",
      }, { env: { MAIL_DRIVER: "file", MAIL_OUT: dir }, fetchImpl });
      const files = readdirSync(dir).sort();

      assert.equal(out.driver, "file");
      assert.equal(calls.length, 0);
      assert.equal(files.length, 2);
      assert.match(files[0], /-hi-there-order-x\.html$/);
      assert.equal(readFileSync(join(dir, files[0]), "utf8"), "<p>hello</p>");
      assert.match(readFileSync(join(dir, files[1]), "utf8"),
        /^To: pat@example.com\nSubject: Hi there: order X\n\nhello\n$/);
    });

  it("posts to Resend with the sender, reply-to and reference id", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init: JSON.parse(init.body), headers: init.headers };

      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    };
    const out = await sendMail(message, { env: live, fetchImpl });

    assert.equal(out.driver, "resend");
    assert.equal(out.id, "email_1");
    assert.equal(seen.url, "https://api.resend.com/emails");
    assert.equal(seen.headers.Authorization, "Bearer re_test");
    assert.equal(seen.init.from, live.MAIL_FROM);
    assert.deepEqual(seen.init.to, ["pat@example.com"]);
    assert.equal(seen.init.reply_to, "sales@example.com");
    assert.equal(seen.init.headers["X-Entity-Ref-ID"], "k-1");
  });

  it("marks 429 and 5xx retryable and 4xx not", async () => {
    const at = (status) => async () =>
      new Response(JSON.stringify({ message: "no" }), { status });

    await assert.rejects(
      sendMail(message, { env: live, fetchImpl: at(500) }),
      (e) => e.retryable === true
    );
    await assert.rejects(
      sendMail(message, { env: live, fetchImpl: at(429) }),
      (e) => e.retryable === true
    );
    await assert.rejects(
      sendMail(message, { env: live, fetchImpl: at(422) }),
      (e) => e.retryable === false && e.status === 422
    );
  });

  it("refuses a message without a recipient", async () => {
    await assert.rejects(sendMail({ subject: "x" }, { env: {} }));
  });
});
