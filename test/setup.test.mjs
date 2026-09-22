import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mailConfigured, sendMail } from "../netlify/functions/lib/mail.mjs";

// If the first test fails, test/setup.mjs is not being loaded in the
// test workers and the suite can send real mail from a Netlify build.
describe("the test environment", () => {
  it("has no live keys and logs mail", () => {
    assert.equal(process.env.MAIL_DRIVER, "log");
    assert.equal(process.env.RESEND_API_KEY, undefined);
    assert.equal(process.env.ADMIN_EMAILS, undefined);
    assert.equal(mailConfigured(process.env), false);
  });

  it("logs rather than send when a test would hit the network", async () => {
    const real = globalThis.fetch;

    globalThis.fetch = async () => {
      throw new Error("a test reached the network");
    };
    try {
      const sent = await sendMail({
        to: "x@example.com", subject: "s", text: "t", html: "<p>t</p>",
      }, {
        env: { MAIL_DRIVER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "f@x" },
      });

      assert.equal(sent.driver, "log");
    } finally {
      globalThis.fetch = real;
    }
  });
});
