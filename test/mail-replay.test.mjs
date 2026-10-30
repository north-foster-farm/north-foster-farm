// SendMail run on Resend's own answers (#471, R6). The fixtures exist
// only if bin/fixtures/record was given a Resend key; staging holds none
// by design (2026-10-17), so without one these tests say so and skip.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { MailError, sendMail } from "../netlify/functions/lib/mail.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { recorded, serve } from "./recorded.mjs";

const have = (name) => existsSync(new URL(
  `./fixtures/resend/${name}.json`, import.meta.url
));
const WHY = "no Resend fixtures: record with a key in the env file";

// The message the recorded request was made from.
const messageOf = (name) => {
  const { request } = recorded("resend", name);
  const b = request.body;

  return {
    to: b.to,
    subject: b.subject,
    text: b.text,
    html: b.html,
    replyTo: b.reply_to,
    idempotencyKey: b.headers["X-Entity-Ref-ID"],
    headers: { "X-Fixture": b.headers["X-Fixture"] },
    attachments: b.attachments.map((a) => ({
      filename: a.filename, content: a.content,
      contentType: a.content_type,
    })),
  };
};

const send = async (name, answers = [name]) => {
  const net = serve("resend", ...answers);
  const env = {
    MAIL_DRIVER: "resend", RESEND_API_KEY: "key", MAIL_FROM: "x@example.com",
    SITE_CONTEXT: "production",
  };
  let result;
  let error;

  try {
    result = await sendMail(messageOf(name), {
      env, fetchImpl: net.impl, stores: testStores(),
    });
  } catch (e) {
    error = e;
  }

  return { result, error, net };
};

describe("sendMail on Resend's answers", () => {
  it("reads the id of a message Resend took",
    { skip: !have("resend-send") && WHY }, async () => {
      const { result, error, net } = await send("resend-send");

      assert.equal(error, undefined);
      assert.deepEqual(result, {
        id: recorded("resend", "resend-send").response.id,
        driver: "resend",
      });
      assert.deepEqual(net.problems, []);
    });

  it("reads Resend's refusal of a sender its key may not use",
    { skip: !have("resend-send-refused") && WHY }, async () => {
      const { error } = await send("resend-send-refused");
      const { status, response } = recorded("resend", "resend-send-refused");

      assert.ok(error instanceof MailError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.detail, response);
    });

  it("reads Resend's 422 for a message it will not send",
    { skip: !have("resend-send-invalid") && WHY }, async () => {
      const { error } = await send("resend-send-invalid");
      const { status, response } = recorded("resend", "resend-send-invalid");

      assert.ok(error instanceof MailError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.detail, response);
    });
});
