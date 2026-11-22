// The implementer's test for qa's find on PR #885 (#793): a perk a
// crashed merge moved, then ended on the target with `perks remove`
// before the rerun, still counts as moved. The rerun moves nothing and
// the perk stays ended. The crash is the criteria test's
// (test/merge-rerun-setup.mjs): the first write to the source's
// record after the merge starts throws once.

import assert from "node:assert/strict";
import { it } from "node:test";

import { perksOf } from "../assets/scripts/order/lib/perks.mjs";
import { addPerk, removePerk } from "../netlify/functions/lib/perks.mjs";
import { getCustomer } from "../netlify/functions/lib/records.mjs";
import {
  FROM, INTO, capture, crashOnSource, later, now, pair, run,
} from "./merge-rerun-setup.mjs";

it("a moved perk ended on the target before the rerun stays ended",
  async (t) => {
    capture(t);

    const stores = await pair();

    await addPerk(stores, FROM, "friends", { by: "cli", now });
    crashOnSource(stores);
    await assert.rejects(run(stores), /blobs down/);
    await removePerk(stores, INTO, "friends", { by: "cli", now: later });

    const report = await run(stores);
    const kept = perksOf(await getCustomer(stores, INTO));

    assert.equal(report.perks, 0, "the rerun moves nothing");
    assert.equal(kept.length, 1, "the target holds one friends perk");
    assert.ok(kept[0].removedAt, "and it stays ended");
    assert.equal(await getCustomer(stores, FROM), null,
      "the rerun finishes the merge");
  });
