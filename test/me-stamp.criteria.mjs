// Criteria tests for #985 (a late 401 can leave the header signed in
// and the order form not), one per box of the issue's "Done when"
// list marked (test) that a unit test can hold, each named for its
// box and written from the issue's words before the implementation.
// The implementer may change how a test runs, never what it expects.
//
// Provisional: the issue's fix is security's proposal, "Let /api/me
// set the stamp again when it finds a live session and the request
// carried none". These tests are written to that proposal.
//
// The browser box ("After a stamp is cleared while the session lives,
// the next page load shows the order form signed in, with the contact
// fields filled") is e2e/stamp-restore.spec.mjs.
//
// Held out of `npm test`, which runs test/**/*.test.mjs, until the fix
// is in. Run it on purpose with
//   node --import ./test/setup.mjs --test test/me-stamp.criteria.mjs
// and turn it on by renaming it to test/me-stamp.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle } from "../netlify/functions/auth.mjs";
import {
  SESSION_TTL, STAMP, createSession,
} from "../netlify/functions/lib/auth.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-11-23T15:00:00Z");
const EMAIL = "stamp@example.com";

// GET /api/me with `cookie` as the request's Cookie header, if any.
const askMe = (stores, cookie, at = now) => handle(
  new Request("https://x/api/me", cookie ? { headers: { cookie } } : {}),
  { stores, now: at, env: {} });

// Every Set-Cookie on the answer that names the stamp.
const stampsSet = (res) => res.headers.getSetCookie()
  .filter((c) => c.startsWith(`${STAMP}=`));

const signedInSession = async () => {
  const stores = testStores();
  const { id } = await createSession(stores, EMAIL, { now });

  return { stores, session: `nff_session=${id}` };
};

describe("/api/me puts back a stamp a live session lost (#985)", () => {
  it("A request to /api/me with a live session and no stamp is answered " +
    "signed in and sets the stamp", async () => {
    const { stores, session } = await signedInSession();
    const res = await askMe(stores, `other=1; ${session}`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.signedIn, true);
    assert.equal(body.customer.email, EMAIL);

    const stamps = stampsSet(res);

    assert.equal(stamps.length, 1, "one stamp is set");

    const [stamp] = stamps;
    const value = stamp.slice(STAMP.length + 1).split(";")[0];

    // A stamp as sign-in sets it: a value scripts can read, beside the
    // session, for the whole site, and kept.
    assert.notEqual(value, "", "the stamp has a value");
    assert.match(stamp, /;\s*Path=\/(;|$)/);
    assert.match(stamp, /;\s*Secure(;|$)/);
    assert.match(stamp, /;\s*SameSite=Lax(;|$)/);
    assert.doesNotMatch(stamp, /HttpOnly/i, "scripts can read it");

    const age = Number((stamp.match(/;\s*Max-Age=(\d+)/) || [])[1]);

    assert.ok(age > 0, "the stamp is kept, not cleared");
    assert.ok(age <= SESSION_TTL / 1000, "it outlives no session");

    // Only the stamp: the session cookie is the browser's already.
    assert.deepEqual(res.headers.getSetCookie().map((c) => c.split("=")[0]),
      [STAMP]);

    // With it back, the page's next ask carries a stamp, and is
    // answered as any stamped one.
    const again = await askMe(stores, `${session}; ${STAMP}=${value}`);

    assert.equal((await again.json()).signedIn, true);
    assert.equal(again.headers.get("set-cookie"), null);
  });

  it("A request to /api/me with a live session and a stamp sets no cookie",
    async () => {
      const { stores, session } = await signedInSession();

      for (const cookie of [
        `${session}; ${STAMP}=mfx3k2`,
        `${STAMP}=mfx3k2; ${session}`,
        `a=1; ${STAMP}=abc; ${session}; b=2`,
      ]) {
        const res = await askMe(stores, cookie);

        assert.equal((await res.json()).signedIn, true, cookie);
        assert.equal(res.headers.get("set-cookie"), null, cookie);
      }
    });

  // A guard: it passes on next and must go on passing.
  it("A request with no live session still clears the stamp, as #149 " +
    "has it", async () => {
    const { stores, session } = await signedInSession();
    const cleared = (res) => {
      const stamps = stampsSet(res);

      return stamps.length === 1 && /^nff_signed_in=;/.test(stamps[0])
        && /;\s*Max-Age=0(;|$)/.test(stamps[0]);
    };
    const late = new Date(now.getTime() + SESSION_TTL + 1);
    const stale = [
      // No session cookie at all, an unknown one, and one past its end.
      [`${STAMP}=abc`, now],
      [`nff_session=${"z".repeat(32)}; ${STAMP}=abc`, now],
      [`${session}; ${STAMP}=abc`, late],
    ];

    for (const [cookie, at] of stale) {
      const res = await askMe(stores, cookie, at);

      assert.equal((await res.json()).signedIn, false, cookie);
      assert.ok(cleared(res), `clears the stamp: ${cookie}`);
    }

    // And with neither a session nor a stamp, nothing to clear or set.
    const bare = await askMe(testStores());

    assert.equal((await bare.json()).signedIn, false);
    assert.equal(bare.headers.get("set-cookie"), null);
  });
});
