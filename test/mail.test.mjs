import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NAME_MAX, adminEmails, mailConfigured, mailbox, sendMail,
} from "../netlify/functions/lib/mail.mjs";

const EMAIL = "pat@example.com";

// What a mail client shows for an RFC 2047 encoded display name.
const decoded = (header) => header.replace(/ <[^>]+>$/, "")
  .split(" ")
  .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"))
  .join("");

describe("mailbox, a customer's name and address for a header", () => {
  it("quotes a name with a comma", () => {
    assert.equal(mailbox("Smith, Jane", EMAIL),
      "\"Smith, Jane\" <pat@example.com>");
  });

  it("escapes quotes and backslashes", () => {
    assert.equal(mailbox("Pat \"Eggs\" O\\Brien", EMAIL),
      "\"Pat \\\"Eggs\\\" O\\\\Brien\" <pat@example.com>");
  });

  it("keeps angle brackets inside the quotes", () => {
    assert.equal(mailbox("Pat <evil@example.net>", EMAIL),
      "\"Pat <evil@example.net>\" <pat@example.com>");
  });

  it("strips line breaks and control characters", () => {
    const got = mailbox("Pat\r\nBcc: evil@example.net\u0000\u2028", EMAIL);

    assert.equal(got, "\"Pat Bcc: evil@example.net\" <pat@example.com>");
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(got, /[\r\n\u0000-\u001f]/);
  });

  it("falls back to the bare address without a name", () => {
    for (const name of ["", "   ", "\r\n", null, undefined]) {
      assert.equal(mailbox(name, EMAIL), EMAIL, JSON.stringify(name));
    }
  });

  it("trims and caps the name", () => {
    assert.equal(mailbox("  Pat   Example  ", EMAIL),
      "\"Pat Example\" <pat@example.com>");
    assert.equal(mailbox("x".repeat(200), EMAIL),
      `"${"x".repeat(NAME_MAX)}" <pat@example.com>`);
  });

  it("encodes a non-ASCII name as RFC 2047 words", () => {
    const got = mailbox("José Núñez", EMAIL);

    assert.match(got, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <pat@example.com>$/);
    assert.equal(decoded(got), "José Núñez");

    const long = mailbox("雞蛋".repeat(40), EMAIL);

    for (const word of long.replace(/ <.*$/, "").split(" ")) {
      assert.ok(word.length <= 75, word);
    }
    assert.equal(decoded(long), "雞蛋".repeat(NAME_MAX / 2));
  });
});

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

    // A message may name its own reply-to (a customer's note does).
    await sendMail({ ...message, replyTo: "pat@example.com" }, {
      env: live, fetchImpl,
    });
    assert.equal(seen.init.reply_to, "pat@example.com");

    // A customer's name goes through to Resend as it was formatted.
    const named = mailbox("Smith, Jane", "jane@example.com");

    await sendMail({ ...message, replyTo: named }, { env: live, fetchImpl });
    assert.equal(seen.init.reply_to, "\"Smith, Jane\" <jane@example.com>");
  });

  it("logs the reply-to with the log driver", async () => {
    const lines = [];
    const info = console.info;

    console.info = (line) => lines.push(JSON.parse(line));
    try {
      await sendMail({
        ...message, replyTo: mailbox("José", "jose@example.com"),
      }, { env: { MAIL_DRIVER: "log" } });
    } finally {
      console.info = info;
    }
    assert.equal(lines[0].event, "mail.logged");
    assert.equal(lines[0].replyTo,
      "=?UTF-8?B?Sm9zw6k=?= <jose@example.com>");
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
