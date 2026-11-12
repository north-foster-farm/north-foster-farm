// The header's account slot from the first paint (#565): hint.js marks
// a page with the session stamp before it is drawn, and Session.show
// leaves a page without one its Sign in link, with no bar over it.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { markSession } from "../assets/scripts/session/hint.js";
import { Session } from "../assets/scripts/session/session.js";

const root = () => ({ dataset: {} });

describe("markSession (#565)", () => {
  it("marks a page with the stamp signed in", () => {
    const doc = {
      cookie: "a=1; nff_signed_in=mfx3k2", documentElement: root(),
    };

    assert.equal(markSession(doc), true);
    assert.equal(doc.documentElement.dataset.session, "in");
  });

  it("leaves a page without one, or with an empty one, alone", () => {
    for (const cookie of ["", "a=1", "nff_signed_in=", "x_nff_signed_in=1"]) {
      const doc = { cookie, documentElement: root() };

      assert.equal(markSession(doc), false, cookie);
      assert.deepEqual(doc.documentElement.dataset, {}, cookie);
    }
  });
});

// Just enough of a header slot for fill(): its Sign in link, the
// Account button and its menu, and the attributes the skeleton sets.
const element = () => {
  const attrs = {};

  return {
    hidden: false,
    dataset: {},
    attrs,
    setAttribute: (name, value) => { attrs[name] = String(value); },
    getAttribute: (name) => attrs[name] ?? null,
    removeAttribute: (name) => { delete attrs[name]; },
    addEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
};

const slotEl = () => {
  const signin = element();
  const menu = element();
  const signout = element();
  const classes = new Set();
  const slot = {
    ...element(),
    signin,
    menu,
    classList: { add: (c) => classes.add(c), has: (c) => classes.has(c) },
    querySelector: (sel) => ({
      "[data-account-signin]": signin,
      "[data-account-menu]": menu,
      "[data-account-signout]": signout,
    })[sel] ?? null,
  };

  signin.setAttribute("href", "/login/");
  menu.hidden = true;

  return slot;
};

// A page at /about/ with its cookies, two slots and /api/me answering
// once `answer` resolves.
const page = (cookie, answer) => {
  const slots = [slotEl(), slotEl()];
  const store = new Map();

  globalThis.document = {
    cookie,
    querySelectorAll: (sel) => (sel === "[data-account]" ? slots : []),
  };
  globalThis.location = { href: "https://example.test/about/",
    pathname: "/about/" };
  globalThis.sessionStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  globalThis.fetch = async () => {
    const body = await answer;

    return { status: 200, ok: true, json: async () => body };
  };

  return slots;
};

const later = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });

  return { promise, resolve };
};

describe("Session.show without the stamp (#565)", () => {
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.sessionStorage;
    delete globalThis.fetch;
  });

  it("settles Sign in at once, with no bar, and keeps it", async () => {
    const answer = later();
    const slots = page("a=1", answer.promise);
    const shown = Session.show();

    for (const slot of slots) {
      assert.equal(slot.signin.hidden, false);
      assert.equal(slot.menu.hidden, true);
      assert.equal(slot.classList.has("is-ready"), true);
      assert.equal(slot.dataset.load, undefined, "no bar");
      assert.equal(slot.signin.getAttribute("href"),
        "/login/?next=%2Fabout%2F");
    }

    answer.resolve({ signedIn: false });
    assert.deepEqual(await shown, { signedIn: false });
    for (const slot of slots) assert.equal(slot.signin.hidden, false);
  });

  it("still swaps in Account for a session without its stamp", async () => {
    const slots = page("", Promise.resolve({
      signedIn: true, customer: { avatar: "hen-brown" },
    }));
    const who = await Session.show();

    assert.equal(who.signedIn, true);
    for (const slot of slots) {
      assert.equal(slot.signin.hidden, true);
      assert.equal(slot.menu.hidden, false);
    }
  });

  it("keeps Sign in when /api/me fails", async () => {
    const slots = page("", Promise.reject(new Error("offline")));

    assert.equal(await Session.show(), null);
    for (const slot of slots) assert.equal(slot.signin.hidden, false);
  });
});

describe("Session.show with the stamp", () => {
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.sessionStorage;
    delete globalThis.fetch;
  });

  it("waits under the skeleton, then shows Account", async () => {
    const answer = later();
    const slots = page("nff_signed_in=abc", answer.promise);
    const shown = Session.show();

    // Let whileLoading start.
    await Promise.resolve();
    for (const slot of slots) {
      assert.equal(slot.dataset.load, "wait");
      assert.equal(slot.classList.has("is-ready"), false);
    }

    answer.resolve({ signedIn: true, customer: {} });
    assert.equal((await shown).signedIn, true);
    for (const slot of slots) {
      assert.equal(slot.menu.hidden, false);
      assert.equal(slot.signin.hidden, true);
      assert.equal(slot.dataset.load, undefined);
    }
  });
});
