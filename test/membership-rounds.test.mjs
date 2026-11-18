// A round between its close and its pickup (#600). 36TS closes at
// 11:59 PM on Saturday and its pickup is 8:30 to 9:00 AM on Sunday.
// roundsNow moved on to the next round at the close, so from then
// until the pickup the Membership tab no longer had the pickup the
// members had just ordered for. It now gives that round as `closed`
// until its pickup window ends.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { roundsNow } from "../netlify/functions/lib/membership.mjs";
import terms from "../netlify/functions/lib/terms.mjs";

const at = (iso) => roundsNow({ series: "36TS" }, terms, new Date(iso));
const pickup = { date: "2026-11-22", closedAt: "2026-11-22T04:59:00.000Z" };

describe("a round's three moments (#600)", () => {
  it("before the close, has no closed round", () => {
    // Saturday noon, and the last second before the close.
    for (const iso of ["2026-11-21T17:00:00Z", "2026-11-22T04:58:59Z"]) {
      const r = at(iso);

      assert.equal(r.closed, null, iso);
      assert.equal(r.current.date, "2026-11-22", iso);
      assert.equal(r.next.date, "2026-12-06", iso);
    }
  });

  it("between the close and the pickup's end, keeps the pickup", () => {
    // The close itself, Saturday's last half minute, Sunday at 8:00 AM
    // and the middle of the pickup window.
    for (const iso of ["2026-11-22T04:59:00Z", "2026-11-22T04:59:30Z",
      "2026-11-22T13:00:00Z", "2026-11-22T13:45:00Z"]) {
      const r = at(iso);

      assert.deepEqual(r.closed, pickup, iso);
      assert.deepEqual(r.current, {
        date: "2026-12-06", closesAt: "2026-12-06T04:59:00.000Z",
      }, iso);
      assert.deepEqual(r.next, {
        date: "2026-12-20", opensAt: "2026-12-06T04:59:00.000Z",
      }, iso);
    }
  });

  it("after the pickup, lets it go", () => {
    // 9:00 AM on Sunday, the window's end, and the Monday after.
    for (const iso of ["2026-11-22T14:00:00Z", "2026-11-23T15:00:00Z"]) {
      const r = at(iso);

      assert.equal(r.closed, null, iso);
      assert.equal(r.current.date, "2026-12-06", iso);
    }
  });

  it("keeps a pickup with no hours until its day ends", () => {
    const model = {
      seriesOf: (code) => {
        const s = terms.model.seriesOf(code);

        return { ...s, opens: null, closes: null };
      },
    };
    const day = (iso) => roundsNow({ series: "36TS" },
      { ...terms, model }, new Date(iso));

    // 11:00 PM on Sunday, then a minute past midnight.
    assert.deepEqual(day("2026-11-23T04:00:00Z").closed, pickup);
    assert.equal(day("2026-11-23T05:01:00Z").closed, null);
  });
});
