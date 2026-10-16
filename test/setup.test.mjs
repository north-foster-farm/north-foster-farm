import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, describe, it } from "node:test";

import { ping } from "../netlify/functions/lib/health.mjs";
import { MailError, sendMail } from "../netlify/functions/lib/mail.mjs";

const blocked = (error) => error.name === "NetworkBlocked";

// What test/setup.mjs blocked; it fails the file if any is left.
const blockedHosts = globalThis[Symbol.for("nff.test.blocked")];

// If these fail, test/setup.mjs is not being loaded in the test
// workers and the suite can reach real services with whatever keys
// the shell that ran it holds.
describe("the test environment", () => {
  // These tests block on purpose.
  afterEach(() => blockedHosts?.splice(0));

  it("keeps only the allowlisted variables and the fixtures", () => {
    const allowed = new Set([
      "PATH", "HOME", "TMPDIR", "TZ", "LANG", "TERM", "CI", "NO_COLOR",
      "FORCE_COLOR", "MAIL_DRIVER", "SQUARE_ENV", "PICKUP_SCHEDULE",
    ]);
    const node = /^NODE_(TEST_|V8_COVERAGE$|CHANNEL_|UNIQUE_ID$)/;
    const extra = Object.keys(process.env)
      .filter((name) => !allowed.has(name) && !node.test(name));

    assert.deepEqual(extra, []);
    assert.ok(Array.isArray(blockedHosts));
    assert.equal(process.env.MAIL_DRIVER, "log");
    assert.equal(process.env.RESEND_API_KEY, undefined);
    assert.equal(process.env.ADMIN_EMAILS, undefined);
  });

  it("throws when a test fetches an outside host", async () => {
    await assert.rejects(fetch("https://api.resend.com/emails"),
      blocked);
  });

  it("throws when a test opens a socket to an outside host", () => {
    assert.throws(() => net.connect(443, "api.squareup.com"),
      blocked);
  });

  it("fails a real send rather than reach Resend", async () => {
    await assert.rejects(sendMail({
      to: "x@example.com", subject: "s", text: "t", html: "<p>t</p>",
    }, {
      env: { MAIL_DRIVER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "f@x" },
    }), (error) => error instanceof MailError &&
      /reached the network/.test(error.detail));
  });

  it("records a block that the code swallowed", async () => {
    assert.equal(await ping("https://hc-ping.com/x"), false);
    assert.deepEqual(blockedHosts, ["hc-ping.com"]);
  });
});
