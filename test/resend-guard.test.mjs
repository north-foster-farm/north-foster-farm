import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { sendMail } from "../netlify/functions/lib/mail.mjs";
import {
  audienceConfigured, removeContact, syncAudience,
} from "../netlify/functions/lib/news.mjs";
import {
  resendAllowed,
} from "../netlify/functions/lib/resend-guard.mjs";

// Staging never sends email (decided 2026-10-17): it reads its mail from
// the outbox driver, and nothing in a staging deploy may reach Resend's
// API. Resend is for production alone.

const live = {
  MAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_test",
  RESEND_AUDIENCE_ID: "aud_1",
  RESEND_AUDIENCE_KEY: "re_audience",
  MAIL_FROM: "North Foster Farm <orders@example.com>",
};
const message = {
  to: "pat@example.com", subject: "Hi", text: "hello", html: "<p>hello</p>",
};
const NOT_PRODUCTION = ["branch-deploy", "deploy-preview", "dev", "scratch"];
const PRODUCTION = ["production", ""];

const spy = () => {
  const calls = [];

  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);

      return new Response(JSON.stringify({ id: "x", data: [] }), {
        status: 200,
      });
    },
  };
};

describe("Resend is for production alone", () => {
  for (const context of NOT_PRODUCTION) {
    describe(`in the ${context} context`, () => {
      const env = { ...live, SITE_CONTEXT: context };

      it("refuses to send mail, and never calls the API", async () => {
        const { calls, fetchImpl } = spy();

        await assert.rejects(sendMail(message, { env, fetchImpl }),
          { name: "MailError", retryable: false });
        assert.equal(calls.length, 0);
      });

      it("treats the audience as unconfigured and calls nothing", async () => {
        const { calls, fetchImpl } = spy();

        assert.equal(audienceConfigured(env), false);
        assert.deepEqual(await syncAudience(undefined, {
          env, fetchImpl, dryRun: true,
        }), { ok: false, reason: "unconfigured" });
        assert.equal(await removeContact("pat@example.com", {
          env, fetchImpl, apply: true,
        }), "unconfigured");
        assert.equal(calls.length, 0);
      });
    });
  }

  for (const context of PRODUCTION) {
    it(`still sends in production (SITE_CONTEXT="${context}")`, async () => {
      const { calls, fetchImpl } = spy();
      const env = { ...live, SITE_CONTEXT: context };
      const out = await sendMail(message, { env, fetchImpl });

      assert.equal(out.driver, "resend");
      assert.deepEqual(calls, ["https://api.resend.com/emails"]);
      assert.equal(audienceConfigured(env), true);
    });
  }

  it("lets the outbox driver through in staging", async () => {
    const { calls, fetchImpl } = spy();
    const stores = { jobs: { list: async () => [], set: async () => {} } };
    const env = { MAIL_DRIVER: "outbox", SITE_CONTEXT: "branch-deploy" };
    const out = await sendMail(message, { env, fetchImpl, stores });

    assert.equal(out.driver, "outbox");
    assert.equal(calls.length, 0);
  });

  it("allows only production and an unset context", () => {
    assert.equal(resendAllowed({ SITE_CONTEXT: "production" }), true);
    assert.equal(resendAllowed({}), true);
    assert.equal(resendAllowed({ SITE_CONTEXT: "branch-deploy" }), false);
  });
});

// A new path to Resend must come with the guard, or this fails.
describe("every file that names Resend's API checks the guard", () => {
  const root = join(import.meta.dirname, "..");
  const sources = (dir) => readdirSync(join(root, dir), {
    recursive: true, withFileTypes: true,
  }).filter((e) => e.isFile() && /\.(mjs|js)$|^nff$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  const naming = [...sources("netlify"), ...sources("bin")]
    .filter((f) => readFileSync(f, "utf8").includes("api.resend.com"));

  it("finds the five modules that call it", () => {
    const names = naming.map((f) => f.slice(root.length + 1)).sort();

    assert.deepEqual(names, [
      "bin/env/verify.mjs",
      "netlify/functions/lib/breaker.mjs",
      "netlify/functions/lib/gate-mail.mjs",
      "netlify/functions/lib/mail.mjs",
      "netlify/functions/lib/news.mjs",
    ]);
  });

  for (const file of naming) {
    it(`${file.slice(root.length + 1)} imports it`, () => {
      // The gate's sign-in mail is the one send outside production, and
      // keeps to the contexts the gate guards instead (lib/gate-mail.mjs).
      assert.match(readFileSync(file, "utf8"), /resendAllowed|gateActive/);
    });
  }
});
