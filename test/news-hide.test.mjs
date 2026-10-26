import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  forgetJoined, remember, remembered, showForms,
} from "../assets/scripts/news/hide.js";

const signedIn = (marketing) => ({
  signedIn: true, customer: { email: "a@example.com", marketing },
});

describe("when the farm news forms show (#267)", () => {
  it("follows the server for a signed-in customer", () => {
    assert.equal(showForms(signedIn(true), false), false);
    assert.equal(showForms(signedIn(false), false), true);
  });

  it("ignores this browser's flag when signed in", () => {
    assert.equal(showForms(signedIn(true), false), false);
    assert.equal(showForms(signedIn(false), true), true);
  });

  it("follows the flag for anyone else", () => {
    assert.equal(showForms({ signedIn: false }, true), false);
    assert.equal(showForms({ signedIn: false }, false), true);
    assert.equal(showForms(null, true), false);
    assert.equal(showForms(null, false), true);
  });
});

describe("this browser's sign-up flag", () => {
  const original = globalThis.localStorage;

  afterEach(() => {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  });

  const fake = () => {
    const held = new Map();

    globalThis.localStorage = {
      getItem: (key) => (held.has(key) ? held.get(key) : null),
      setItem: (key, value) => held.set(key, String(value)),
      removeItem: (key) => held.delete(key),
    };

    return held;
  };

  it("is set by a sign-up, cleared by an unsubscribe, and holds no address",
    () => {
      const held = fake();

      assert.equal(remembered(), false);
      remember();
      assert.equal(remembered(), true);
      assert.doesNotMatch([...held.values()].join(" "), /@/);
      forgetJoined();
      assert.equal(remembered(), false);
    });

  it("is missing, not an error, where storage is blocked", () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };

    assert.equal(remembered(), false);
    assert.doesNotThrow(remember);
    assert.doesNotThrow(forgetJoined);
  });
});
