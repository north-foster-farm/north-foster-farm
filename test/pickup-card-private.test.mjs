// A buying group's place on its pickup card (#703, qa on #720): the
// place is private and the home map never pins it, so its card has
// Copy and no Map. The places come as /api/group serves them
// (lib/groups.mjs privatePlaces), not hand-made.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickupCard } from "../assets/scripts/order/lib/scheduled.mjs";
import { privatePlaces } from "../netlify/functions/lib/groups.mjs";
import groupData from "../data/groups.json" with { type: "json" };
import locationData from "../data/locations.json" with { type: "json" };

const entry = {
  occurrence: "36TS-261205", date: "2026-12-05",
  label: "Saturday, December 5", series: "36TS", name: "Pickup",
  window: "5:00 – 6:00 PM",
};

describe("a private place's pickup card", () => {
  for (const group of groupData.groups) {
    const [place] = privatePlaces(group).locations;

    it(`${group.key}: Copy, and no Map`, () => {
      assert.equal(place.private, true, "the group's place is private");

      const card = pickupCard(entry, place);

      assert.equal(card.map, "");
      assert.equal(card.copy,
        `${place.street}, ${place.city}, ${place.state} ${place.zip}`);
    });
  }

  it("a public place keeps its Map", () => {
    const place = locationData.locations
      .find((l) => !l.private && !l.archived);

    assert.match(pickupCard(entry, place).map, /^\/#place-[a-z0-9-]+$/);
  });
});
