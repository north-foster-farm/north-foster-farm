// #294: the toolbar's clock field, read in the farm's zone, and the
// order page's card overlay, once per gate session.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SEEN, maybeShowOverlay,
} from "../assets/scripts/staging/card.js";
import { fieldValue, fromField } from "../assets/scripts/staging/clock.js";

const TZ = "America/New_York";

describe("the clock's field", () => {
  it("reads farm time, across a change of clocks", () => {
    assert.equal(fromField("2026-12-31T06:00", TZ).toISOString(),
      "2026-12-31T11:00:00.000Z");
    assert.equal(fromField("2026-07-01T06:00", TZ).toISOString(),
      "2026-07-01T10:00:00.000Z");
    assert.equal(fromField("", TZ), null);
    assert.equal(fromField("soon", TZ), null);
  });

  it("shows an instant as the farm's clocks read it", () => {
    const at = new Date("2027-01-01T04:59:00Z");

    assert.equal(fieldValue(at, TZ), "2026-12-31T23:59");
    assert.equal(fromField(fieldValue(at, TZ), TZ).getTime(), at.getTime());
  });
});

// Just enough of a page for the overlay.
const page = (path, stored = {}) => {
  const listeners = {};
  const classes = new Set();
  const dialog = {
    open: false,
    showModal() { this.open = true; },
    close() {
      this.open = false;
      listeners.close();
    },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    querySelector: () => ({ addEventListener: () => {} }),
  };
  const main = {
    focused: false, attrs: {}, isConnected: true,
    hasAttribute(n) { return n in this.attrs; },
    setAttribute(n, v) { this.attrs[n] = v; },
    focus() { this.focused = true; },
  };
  const body = {};
  const doc = {
    location: { pathname: path },
    activeElement: body,
    body,
    documentElement: { classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
    } },
    querySelector: (sel) => (sel === "main" ? main
      : sel === "[data-staging-card-dialog]" ? dialog : null),
  };

  globalThis.window = { localStorage: {
    getItem: (k) => stored[k] ?? null,
    setItem: (k, v) => { stored[k] = v; },
  } };

  return { doc, dialog, main, classes, stored };
};

describe("the card overlay", () => {
  it("shows on the order page the first time, and locks the page", () => {
    const p = page("/order/");

    assert.equal(maybeShowOverlay({ session: "s1", doc: p.doc }), true);
    assert.equal(p.dialog.open, true);
    assert.ok(p.classes.has("staging-modal-open"));

    p.dialog.close();
    assert.equal(p.stored[SEEN], "s1", "closing marks it seen");
    assert.ok(!p.classes.has("staging-modal-open"));
    assert.equal(p.main.focused, true, "focus back on the page");
  });

  it("stays shut once seen in this gate session, and opens in the next",
    () => {
      assert.equal(maybeShowOverlay({
        session: "s1", doc: page("/order/", { [SEEN]: "s1" }).doc,
      }), false);
      assert.equal(maybeShowOverlay({
        session: "s2", doc: page("/order/", { [SEEN]: "s1" }).doc,
      }), true);
    });

  it("shows nowhere but the order page, and never without a session",
    () => {
      assert.equal(maybeShowOverlay({
        session: "s1", doc: page("/about/").doc,
      }), false);
      assert.equal(maybeShowOverlay({
        session: "s1", doc: page("/order/thanks/").doc,
      }), false);
      assert.equal(maybeShowOverlay({
        session: null, doc: page("/order/").doc,
      }), false);
    });
});
