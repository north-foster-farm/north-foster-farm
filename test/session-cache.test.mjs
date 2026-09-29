import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TTL, fresh, stampFrom } from "../assets/scripts/session/cache.js";

const out = { signedIn: false };
const cached = (stamp, at = 1000) => ({ at, stamp, me: out });

describe("session cache", () => {
  it("reads the stamp from the cookies, or none", () => {
    assert.equal(stampFrom("a=1; nff_signed_in=mfx3k2; b=2"), "mfx3k2");
    assert.equal(stampFrom("nff_signed_in=mfx3k2"), "mfx3k2");
    assert.equal(stampFrom("a=1; b=2"), "");
    assert.equal(stampFrom("nff_signed_in="), "");
    assert.equal(stampFrom(""), "");
    assert.equal(stampFrom(undefined), "");
  });

  it("keeps an answer for five minutes under the same stamp", () => {
    assert.equal(fresh(cached(""), "", 1000 + TTL - 1), out);
    assert.equal(fresh(cached("mfx3k2"), "mfx3k2", 2000), out);
    assert.equal(fresh(cached(""), "", 1000 + TTL), null);
  });

  // #159: signed out on /login/, then in through the link in the same
  // tab; the stamp is new, so "Sign in" goes at once.
  it("drops an answer cached before a sign-in", () => {
    assert.equal(fresh(cached(""), "mfx3k2", 2000), null);
    assert.equal(fresh(cached("mfx3k2"), "mfx9zz", 2000), null);
  });

  it("drops an answer cached before a sign-out", () => {
    assert.equal(fresh(cached("mfx3k2"), "", 2000), null);
  });

  it("drops an answer from before stamps, and nothing at all", () => {
    assert.equal(fresh({ at: 1000, me: out }, "", 2000), null);
    assert.equal(fresh(null, "", 2000), null);
  });
});
