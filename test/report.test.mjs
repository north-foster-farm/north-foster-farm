import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

import {
  browserOf, clientDetail,
} from "../netlify/functions/lib/client-report.mjs";

const source = readFileSync(new URL("../assets/scripts/report.js",
  import.meta.url), "utf8");

// The reporter in a page of its own: a window that records its
// listeners, and a beacon that records what it was given (or throws).
const page = ({ beacon = "ok", build = "abc123" } = {}) => {
  const sent = [];
  const listeners = {};
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const context = {
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

  vm.runInNewContext(source, context);

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
