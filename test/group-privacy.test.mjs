// What a member is told before any host sees them (#495, part 1, and
// James's decisions 3 and 5): the privacy policy says the host sees
// the name, the email address and the date joined, and a join dialog
// asks before a group's code, join link or QR code applies. No host
// sees a member's email address before these ship.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { confirmJoin } from "../assets/scripts/group/join-dialog.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url),
  "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

const POLICY = [
  "If you use a group's code, you join that group, and its host can " +
    "see your name, your email address and when you joined.",
  "The host never sees your orders, your phone number, your address " +
    "or how you paid.",
  "You can leave a group at any time from your account page.",
];
// James's approved wording (#495, decision 5).
const SEES = "The group's host can see your name and email address.";
const BODY = `You'll get member prices and the group's pickup. ${SEES}`;

// Just enough of a <dialog> and its document for confirmJoin.
const fakePage = () => {
  const listeners = {};
  const on = (name) => ({
    addEventListener: (type, fn) => { listeners[`${name}:${type}`] = fn; },
    removeEventListener: (type) => { delete listeners[`${name}:${type}`]; },
    focus: () => {},
  });
  const yes = on("yes");
  const no = on("no");
  const nameEl = { textContent: "" };
  const dialog = {
    ...on("dialog"),
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector: (s) => ({
      "[data-group-join-yes]": yes,
      "[data-group-join-no]": no,
      "[data-group-join-name]": nameEl,
    })[s],
  };
  const root = {
    activeElement: null,
    getElementById: (id) => (id === "group-join" ? dialog : null),
  };
  const fire = (key, event = {}) => listeners[key](event);

  return { root, dialog, nameEl, fire, listeners };
};

describe("what a member is told the host sees", () => {
  it("is in the privacy policy, under how information is used",
    async () => {
      const policy = flat(await read("content/privacy.md"));
      const usage = policy.slice(policy.indexOf("## Information usage"));

      for (const line of POLICY) assert.ok(usage.includes(line), line);
    });

  it("is the join dialog's, in James's approved words", async () => {
    const html = flat(await read("layouts/partials/group/join-dialog.html"));

    assert.match(html, /<dialog [^>]*id="group-join"/);
    assert.match(html,
      /Join <span data-group-join-name><\/span>\?<\/h2>/);
    assert.ok(html.includes(`>${BODY}</p>`), "the body");
    assert.match(html, />Join group<\/button>/);
    assert.match(html, />Cancel<\/button>/);
  });

  it("asks on the order page and the sign-up page, and the sign-up " +
    "page says it too", async () => {
    for (const page of [
      "layouts/partials/order/form.html", "layouts/join/single.html",
    ]) {
      assert.match(await read(page), /partial "group\/join-dialog\.html"/,
        page);
    }
    assert.ok(flat(await read("layouts/join/single.html")).includes(SEES));
  });

  it("replaces the note under the code box", async () => {
    const cart = await read("layouts/partials/order/cart.html");

    assert.doesNotMatch(cart, /data-group-note/);
    assert.ok(!cart.includes(SEES));
  });
});

describe("the join dialog", () => {
  it("names the group, and Join group says yes", async () => {
    const page = fakePage();
    const answer = confirmJoin("The Gym", { root: page.root });

    assert.equal(page.dialog.open, true);
    assert.equal(page.nameEl.textContent, "The Gym");
    page.fire("yes:click");
    assert.equal(await answer, true);
    assert.equal(page.dialog.open, false);
    assert.deepEqual(Object.keys(page.listeners), [], "nothing left wired");
  });

  it("says no on Cancel and on Escape", async () => {
    const page = fakePage();
    const cancel = confirmJoin("The Gym", { root: page.root });

    page.fire("no:click");
    assert.equal(await cancel, false);

    let prevented = false;
    const escape = confirmJoin("The Gym", { root: page.root });

    page.fire("dialog:cancel", { preventDefault: () => { prevented = true; } });
    assert.equal(await escape, false);
    assert.equal(prevented, true);
    assert.equal(page.dialog.open, false);
  });

  it("joins nothing unasked when the page has no dialog", async () => {
    const root = { getElementById: () => null };

    assert.equal(await confirmJoin("The Gym", { root }), false);
  });
});
