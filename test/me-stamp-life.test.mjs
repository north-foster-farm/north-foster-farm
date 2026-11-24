// Criteria test for #985, the box security added after reading PR
// #1001: a stamp /api/me puts back lives no longer than the session
// it stands for. Sessions do not slide (lib/auth.mjs's createSession
// stores `expires` as its creation time plus SESSION_TTL, in ms, and
// nothing moves it), so stampHeader's default Max-Age, a full
// SESSION_TTL from now, would let a stamp put back late in a session
// outlive it by up to a full lifetime. Written from the box's words
// before the implementation; the implementer may change how the test
// runs, never what it expects.
//
// Provisional, as test/me-stamp.criteria.mjs is: it holds security's
// proposal that /api/me sets the stamp again for a live session.
//
// Rounding: Max-Age is whole seconds, and the box says "never more"
// than the time left, so the one value that holds is the floor of
// (expires - now) / 1000. Rounding up or to nearest would outlive the
// session by under a second, and anything lower ends the stamp early
// for no reason. The clock is set half a second off a whole second, so
// a Math.round or Math.ceil fails here as a full lifetime does.
//
// Held out of `npm test`, which runs test/**/*.test.mjs, until the fix
// is in. Run it on purpose with
//   node --import ./test/setup.mjs --test test/me-stamp-life.criteria.mjs
// and turn it on by renaming it to test/me-stamp-life.test.mjs.

import assert from "node:assert/strict";
import { it } from "node:test";

import { handle } from "../netlify/functions/auth.mjs";
import {
  SESSION_TTL, STAMP, createSession,
} from "../netlify/functions/lib/auth.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

it("When /api/me sets the stamp for a live session, the stamp's Max-Age " +
  "is the time that session has left, not a full lifetime", async () => {
  const stores = testStores();
  const created = new Date("2026-11-01T09:00:00Z");
  const { id } = await createSession(stores, "life@example.com",
    { now: created });
  const expires = created.getTime() + SESSION_TTL;

  // Part-way through its life: a third of it gone, and half a second.
  const at = new Date(created.getTime() + Math.floor(SESSION_TTL / 3) + 500);
  const left = Math.floor((expires - at.getTime()) / 1000);

  assert.ok(left > 0 && left < SESSION_TTL / 1000, "the session is live");

  const req = new Request("https://x/api/me",
    { headers: { cookie: `nff_session=${id}` } });
  const res = await handle(req, { stores, now: at, env: {} });

  assert.equal((await res.json()).signedIn, true);

  const stamps = res.headers.getSetCookie()
    .filter((c) => c.startsWith(`${STAMP}=`));

  assert.equal(stamps.length, 1, "one stamp is set");

  const age = (stamps[0].match(/;\s*Max-Age=(\d+)(;|$)/) || [])[1];

  assert.equal(Number(age), left,
    `Max-Age is the ${left} seconds the session has left`);
});
