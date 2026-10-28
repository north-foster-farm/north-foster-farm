import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, describe, it } from "node:test";

import { ping } from "../netlify/functions/lib/health.mjs";
import { MailError, sendMail } from "../netlify/functions/lib/mail.mjs";
import { inventoryCounts } from "../netlify/functions/lib/square.mjs";
import { liveCounts } from "../netlify/functions/lib/stock.mjs";
import { pinsAllowed } from "../netlify/functions/lib/stock-pins.mjs";
import {
  productionRead, productionStock, stockOverrides,
} from "../netlify/functions/lib/stock-source.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

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
    assert.equal(process.env.FARM_NOTIFICATIONS_EMAIL, undefined);
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

  // No unit test reads a real stock source (#507): each injects its own
  // store and inventory. With the environment as the tests see it, no
  // Square is asked, production's /api/stock is off, and neither the
  // hand overrides nor a test pin can apply; a store left empty reads
  // as nothing, and a reach for production is blocked.
  it("leaves no real stock source for a test to read", async () => {
    assert.equal(productionRead(), false);
    assert.deepEqual(stockOverrides(), {});
    assert.equal(pinsAllowed(), false);
    assert.equal(await inventoryCounts(["S7XJNPQUKY6JSYQOEYSL6FYS"]), null);
    assert.deepEqual(await liveCounts(testStores(), { scope: "a-scope-id" }),
      {});
    await assert.rejects(productionStock(["NFF-CHK-EGG-LG"]),
      /Network error calling production/);
    assert.deepEqual(blockedHosts, ["www.northfosterfarm.com"]);
  });
});
