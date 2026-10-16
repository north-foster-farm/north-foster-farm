import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  SENT, STORED, WHERES, allow, scrub,
} from "../assets/scripts/report/fields.mjs";
import { install } from "../assets/scripts/report/reporter.mjs";
import {
  browserOf, clientDetail,
} from "../netlify/functions/lib/client-report.mjs";

// The reporter in a page of its own: a window that records its
// listeners, and a beacon that records what it was given (or throws).
const page = ({ beacon = "ok", build = "abc123" } = {}) => {
  const sent = [];
  const listeners = {};
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const scope = {
    window,
    document: { currentScript: { dataset: { build } } },
    location: { pathname: "/order/", search: "?edit=NFF-1234" },
    performance: { now: (() => { let t = 0; return () => (t += 100); })() },
    Blob: class { constructor(parts) { this.text = parts.join(""); } },
    navigator: {
      sendBeacon: (url, blob) => {
        if (beacon === "throws") throw new Error("no beacons");
        sent.push({ url, body: JSON.parse(blob.text) });

        return beacon === "ok";
      },
    },
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), fetched: true });
    },
  };

  install(scope);

  return { report: window.nffReport, listeners, sent };
};

describe("the browser's error reporter", () => {
  it("sends a report with its context and no query string", () => {
    const { report, sent } = page();

    report.crumb("pay.load");
    report.crumb("not.a.step");
    report.sdk("square", "loading");
    report.sdk("square", "failed");
    report("payment.unavailable", {
      where: "square.load", error: new Error("Could not load sdk"),
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "/api/health");

    const body = sent[0].body;

    assert.equal(body.kind, "payment.unavailable");
    assert.equal(body.where, "square.load");
    assert.equal(body.message, "Could not load sdk");
    assert.match(body.stack, /Could not load sdk/);
    assert.equal(body.build, "abc123");
    assert.equal(body.page, "/order/", "the path only: ?edit= has an id");
    assert.deepEqual(body.crumbs, ["page.load", "pay.load"]);
    assert.deepEqual(body.sdks, { square: { state: "failed", ms: 100 } });
  });

  it("hooks the window's errors and rejections", () => {
    const { listeners, sent } = page();

    listeners.error({ error: new TypeError("x is undefined"),
      message: "x is undefined" });
    listeners.error({ error: null, message: "Script error." });
    listeners.unhandledrejection({ reason: new Error("nope") });

    assert.deepEqual(sent.map((s) => [s.body.kind, s.body.where]), [
      ["error", "window.error"], ["error", "window.rejection"],
    ]);
  });

  it("sends each report once, five at most, and only known kinds", () => {
    const { report, sent } = page();

    report("error", { where: "a", error: "same" });
    report("error", { where: "a", error: "same" });
    report("anything", { where: "a", error: "x" });
    for (let i = 0; i < 10; i += 1) {
      report("error", { where: "b", error: `n${i}` });
    }
    assert.equal(sent.length, 5);
  });

  it("never throws, whatever it is given", () => {
    const { report, listeners } = page({ beacon: "throws" });
    const hostile = {};

    Object.defineProperty(hostile, "message", {
      get: () => { throw new Error("gotcha"); },
    });

    assert.doesNotThrow(() => {
      report("error", { where: "x", error: hostile });
      report("error");
      report("error", null);
      report();
      report.crumb(undefined);
      report.sdk(null, {});
      listeners.error(null);
      listeners.unhandledrejection(undefined);
    });
  });

  it("falls back to fetch when the beacon is refused", () => {
    const { report, sent } = page({ beacon: "refused" });

    report("error", { where: "x", error: "y" });
    assert.equal(sent.filter((s) => s.fetched).length, 1);
  });
});

describe("a report as the server keeps it", () => {
  it("names the browser family and major version, nothing more", () => {
    const cases = [
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/" +
        "537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome", 141],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 " +
        "Mobile/15E148 Safari/604.1", "Safari", 18],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      "Edge", 141],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 " +
        "Firefox/143.0", "Firefox", 143],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 " +
        "Mobile/15E148 Safari/604.1", "Chrome", 141],
      ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like " +
        "Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
      "Samsung Internet", 28],
      ["curl/8.7.1", "Other", null],
      [null, "Other", null],
    ];

    for (const [ua, browser, browserVersion] of cases) {
      assert.deepEqual(browserOf(ua), { browser, browserVersion }, ua);
    }
  });

  it("keeps its own fields, trimmed, and no order", () => {
    const d = clientDetail({
      where: "card.attach", message: "m".repeat(400), stack: "s".repeat(3000),
      build: "abc", page: "/order/", crumbs: Array(30).fill("pay.press"),
      sdks: { square: { state: "ready", ms: 812.4 }, paypal: "junk" },
      orderId: "NFF-1234", email: "a@b.com",
    }, "Mozilla/5.0 Firefox/143.0");

    assert.equal(d.message.length, 300);
    assert.equal(d.stack.length, 2000);
    assert.equal(d.crumbs.length, 20);
    assert.deepEqual(d.square, { state: "ready", ms: 812 });
    assert.equal(d.paypal, null);
    assert.equal(d.browser, "Firefox");
    assert.equal("orderId" in d, false);
    assert.equal("email" in d, false);
  });
});

// The fake customer of e2e/report-privacy.spec.mjs, in every way the
// order form takes an email or a phone number (validate.mjs).
const EMAILS = ["qa-pii@example.com", "Zeb.O'Hara+farm@mail.example.co.uk"];
const PHONES = [
  "4015550123", "401-555-0123", "(401) 555-0123", "401.555.0123",
  "401 555 0123", "+1 401 555 0123", "1-401-555-0123", "14015550123",
];
// The odder shapes the form's checks also let through (qa, 7bd19d9).
const ODD_PHONES = [
  "617/555/1234", "617_555_1234", "617\u2013555\u20131234",
  "6 1 7 5 5 5 1 2 3 4", "61-75-55-12-34", "617-5551-234",
  "617-555-1234x", "a6175551234", "tel:6175551234", "617 - 555 - 1234",
  "617\u00a0555\u00a01234", "+ 1 617 555 1234",
];
const ODD_EMAILS = [
  "a(b)@x.com", "\"jane\"@x.com", "a@b,c.com", "j@[1.2.3.4].com",
  "jane@ex(ample).com", "j\u00e9@ex.com",
];

describe("the report's allowlist and scrubber (#258)", () => {
  it("scrubs every email and phone shape the order form accepts", () => {
    for (const value of [...EMAILS, ...PHONES]) {
      const out = scrub(`Invalid value '${value}' in field`);

      assert.equal(out.includes(value), false, value);
      assert.match(out, /\[(email|phone)\]/, value);
      assert.equal(/\d{3}.?\d{4}/.test(out), false, `${value}: ${out}`);
    }
  });

  it("scrubs the odder shapes too", () => {
    for (const value of ODD_PHONES) {
      const out = scrub(`bad ${value}`);

      assert.equal(out.replace(/\D/g, "").includes("5551234"), false,
        `${value}: ${out}`);
    }
    for (const value of ODD_EMAILS) {
      const out = scrub(`bad ${value} here`);
      const domain = value.split("@")[1];

      assert.equal(out.includes(domain), false, `${value}: ${out}`);
      assert.match(out, /\[email\]/, value);
    }
  });

  it("scrubs what is glued to a run of hex (qa, dec1074)", () => {
    const H = "0123456789abcdef0123456789abcdef";

    for (const value of [
      `${H}6175551234`, `6175551234${H}`, `${H} 6175551234`,
      `${H}-617-555-1234`, `id=${H.slice(0, 22)}6175551234`,
    ]) {
      const out = scrub(value);

      assert.equal(out.replace(/\[phone\]/, "").includes("5551234"), false,
        `${value}: ${out}`);
    }
    for (const value of [
      "deadbeefdeadbeefdeadbeefdeadbeef01@x.com", `jane@${H}.com`,
      `${H}jane@x.com`, `jane@x.com${H}`,
    ]) {
      assert.match(scrub(value), /\[email\]/, value);
      assert.equal(scrub(value).includes("@"), false, value);
    }
  });

  it("names only the places the code reports from", () => {
    const pay = readFileSync(new URL("../assets/scripts/order/pay.js",
      import.meta.url), "utf8");
    const used = [...pay.matchAll(
      /report(?:Error|Unavailable)\("([^"]+)"/g)].map((m) => m[1]);

    assert.ok(used.length >= 11);
    for (const where of used) assert.ok(WHERES.includes(where), where);
    assert.equal(clientDetail({ where: "made.up" }).where, null);
    assert.equal(clientDetail({ where: "paypal.render" }).where,
      "paypal.render");

    const { report, sent } = page();

    report("error", { where: "made.up", error: "x" });
    assert.equal(sent[0].body.where, null);
  });

  it("leaves a stack's places and fingerprints alone", () => {
    // A fingerprint with phone-shaped runs of digits in it.
    const HEX = `e1${"4015550123".repeat(3)}${"ab".repeat(20)}`;
    const stack = "TypeError: x\n" +
      `    at Payment.init (https://x/scripts/order/main.${
        "12345678901234ab".repeat(8)}.js:1:2345678)\n` +
      "initSquare@https://www.northfosterfarm.com/scripts/report.js:1:10" +
      `\n    at f (https://x/scripts/order/main.${HEX}.js:1:2345678901)`;

    assert.equal(scrub(stack), stack);
  });

  it("keeps only the listed keys", () => {
    assert.deepEqual(allow({ kind: "error", email: "x", orderId: "y" }, SENT),
      { kind: "error" });
    assert.deepEqual(allow(null, SENT), {});
  });

  it("sends no key that is not on the list, and scrubs the message",
    () => {
      const { report, sent } = page();
      const error = new Error(`Bad contact ${EMAILS[0]} ${PHONES[2]}`);

      error.orderId = "NFF-1234";
      report("error", { where: "card.attach", error, email: EMAILS[0] });

      const body = sent[0].body;

      assert.deepEqual(Object.keys(body).sort(), [...SENT].sort());
      assert.match(body.message, /^Bad contact \[email\] \(?\[phone\]$/);
      assert.equal(JSON.stringify(body).includes(EMAILS[0]), false);
      assert.equal(JSON.stringify(body).includes("555-0123"), false);
    });

  it("scrubs before it cuts, so no half address survives", () => {
    const { report, sent } = page();

    report("error", { where: "x", error: `${"y".repeat(290)} ${EMAILS[0]}` });
    assert.equal(sent[0].body.message.includes("qa-pii"), false);
  });

  it("stores a report with an extra key without it", () => {
    const d = clientDetail({
      kind: "error", where: "x", message: `call ${PHONES[0]}`,
      stack: `Error: ${EMAILS[1]}\n    at f (https://x/a.js:1:2)`,
      crumbs: ["pay.load", "typed: qa-pii@example.com"],
      sdks: { square: { state: "ready", ms: 5, email: "x" },
        paypal: { state: "bogus" } },
      customer: { email: EMAILS[0] }, orderId: "NFF-1234",
    }, "Mozilla/5.0 Firefox/143.0");

    assert.deepEqual(Object.keys(d).sort(), [...STORED].sort());
    assert.equal(d.message, "call [phone]");
    assert.match(d.stack, /^Error: \[email\]\n/);
    assert.deepEqual(d.crumbs, ["pay.load"]);
    assert.deepEqual(d.square, { state: "ready", ms: 5 });
    assert.equal(d.paypal, null);
    assert.equal(JSON.stringify(d).includes("qa-pii"), false);
  });

  it("keeps a where and a build only by their shape, and scrubs the page",
    () => {
      const d = clientDetail({
        where: "card.attach jane@x.com", build: "not a sha",
        page: "/order/4015550123/",
      }, "");

      assert.equal(d.where, null);
      assert.equal(d.build, null);
      assert.equal(d.page, "/order/[phone]/");
      assert.equal(clientDetail({ where: "square.load" }).where,
        "square.load");
      assert.equal(clientDetail({ build: "7f4451c" }).build, "7f4451c");
    });
});
