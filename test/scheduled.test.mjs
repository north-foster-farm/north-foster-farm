import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addressLines, draftOccurrence, dropOnly, dropSeriesCode, fallbackChoice,
  fulfilmentDate, locationCount, locationsLabel, occurrenceId, pickupName,
  pickupParts, placeNames, placesFact, scheduledChoice,
} from "../assets/scripts/order/lib/scheduled.mjs";

const drop = {
  occurrence: "VFVQ-261024", date: "2026-10-24",
  label: "Saturday, October 24", series: "VFVQ", name: "Drop site",
  town: "Scituate", window: "10:00 – 11:00 AM",
};
const foster = {
  occurrence: "WAC5-261101", date: "2026-11-01",
  label: "Sunday, November 1", series: "WAC5",
  name: "Foster Farmers Market", town: "Foster", window: "9:00 AM – 1:00 PM",
};
const pop = { ...foster, series: "ZZ9Q", name: "Summer Concert" };

describe("a scheduled choice", () => {
  it("is valued by its occurrence id", () => {
    assert.equal(scheduledChoice(foster).value, "WAC5-261101");
  });

  it("reads date, place, town and the window as the server prints it", () => {
    assert.equal(
      scheduledChoice(drop).text,
      "Saturday, October 24: Drop site, Scituate, 10:00 – 11:00 AM"
    );
  });
});

describe("the places a list reaches", () => {
  it("names each once, in date order", () => {
    assert.deepEqual(placeNames([drop, foster, drop]),
      ["Drop site", "Foster Farmers Market"]);
  });

  it("joins two with and, three with commas, more with and more", () => {
    assert.equal(placesFact([drop, foster]),
      "Drop site and Foster Farmers Market");
    assert.equal(placesFact([drop, foster, pop]),
      "Drop site, Foster Farmers Market, and Summer Concert");
    assert.equal(
      placesFact([drop, foster, pop, { ...pop, name: "Pop-up" }]),
      "Drop site, Foster Farmers Market, Summer Concert, and more"
    );
  });

  it("knows when only the drop site is in it", () => {
    assert.equal(dropOnly([drop, drop], "VFVQ"), true);
    assert.equal(dropOnly([drop, foster], "VFVQ"), false);
  });
});

describe("an occurrence id", () => {
  it("is the series code, a dash and the date as YYMMDD", () => {
    assert.equal(occurrenceId("VFVQ", "2026-10-24"), "VFVQ-261024");
  });
});

describe("the occurrence a saved draft meant", () => {
  it("is its own", () => {
    assert.equal(
      draftOccurrence({ method: "scheduled", occurrence: "WAC5-261101" },
        "VFVQ"),
      "WAC5-261101"
    );
  });

  it("is the drop series' on its date for a draft from before", () => {
    assert.equal(
      draftOccurrence({ method: "scituate", date: "2026-10-24" }, "VFVQ"),
      "VFVQ-261024"
    );
  });

  it("is none for anything else", () => {
    assert.equal(draftOccurrence({ method: "scituate" }, "VFVQ"), "");
    assert.equal(draftOccurrence({ method: "delivery", date: "2026-10-24" },
      "VFVQ"), "");
  });
});

describe("the day a fulfilment falls on", () => {
  const find = (id) => (id === drop.occurrence ? drop : null);

  it("is the date it carries", () => {
    assert.equal(fulfilmentDate({ method: "delivery", date: "2026-10-30" },
      find), "2026-10-30");
  });

  it("is the occurrence's date for a scheduled one with none", () => {
    assert.equal(fulfilmentDate(
      { method: "scheduled", occurrence: drop.occurrence }, find
    ), "2026-10-24");
  });

  it("is empty for an occurrence the lists never had", () => {
    assert.equal(fulfilmentDate(
      { method: "scheduled", occurrence: "NONE-261024" }, find
    ), "");
  });
});

describe("the drop series code", () => {
  it("is the code of the series of kind drop-site", () => {
    const model = { series: [
      { code: "WAC5", kind: "market" },
      { code: "VFVQ", kind: "drop-site" },
    ] };

    assert.equal(dropSeriesCode(model), "VFVQ");
  });

  it("is null where the farm has no drop site", () => {
    assert.equal(dropSeriesCode({ series: [{ code: "WAC5", kind: "market" }] }),
      null);
  });
});

describe("the choice that replaces a closed one", () => {
  const nextDrop = { ...drop, occurrence: "VFVQ-261031" };

  it("is the named series' next, not the list's first", () => {
    assert.equal(fallbackChoice([foster, nextDrop], "VFVQ"), nextDrop);
  });

  it("is the first where no series is named", () => {
    assert.equal(fallbackChoice([foster, nextDrop]), foster);
  });

  it("is nothing where the named series has no entry left", () => {
    assert.equal(fallbackChoice([foster], "VFVQ"), undefined);
  });
});

describe("the locations a list reaches", () => {
  it("counts each place once, by location", () => {
    const a = { ...drop, location: "G4C6" };
    const b = { ...foster, location: "H2P8" };

    assert.equal(locationCount([a, b, { ...a, occurrence: "x" }]), 2);
    assert.equal(locationCount([a]), 1);
  });

  it("falls back to the series where an entry has no location", () => {
    assert.equal(locationCount([drop, foster]), 2);
  });
});

describe("the link's words for a count", () => {
  it("is singular for one, plural for any other number", () => {
    assert.equal(locationsLabel(1), "1 location");
    assert.equal(locationsLabel(2), "2 locations");
    assert.equal(locationsLabel(3), "3 locations");
    assert.equal(locationsLabel(0), "0 locations");
    assert.equal(locationsLabel(12), "12 locations");
  });

  it("reads the live count of a list, so no number is typed anywhere",
    () => {
      const a = { ...drop, location: "G4C6" };
      const b = { ...foster, location: "H2P8" };
      const label = (choices) => locationsLabel(locationCount(choices));

      assert.equal(label([a]), "1 location");
      assert.equal(label([a, { ...a, occurrence: "x" }]), "1 location",
        "two days at one place are one location");
      assert.equal(label([a, b]), "2 locations");
      assert.equal(label([a, b, drop]), "3 locations");
    });
});

describe("a pickup as its card's parts", () => {
  const green = {
    name: "The Village Green", street: "46 Institute Lane",
    city: "North Scituate", state: "RI", zip: "02857",
  };

  it("gives the day, the hours, the subtitle and the address", () => {
    assert.deepEqual(pickupParts(drop, green), {
      date: "Saturday, October 24",
      time: "10:00 – 11:00 AM",
      name: "Scituate · Drop site",
      address: [
        "The Village Green", "46 Institute Lane", "North Scituate, RI 02857",
      ],
    });
  });

  it("names the town once (#439)", () => {
    assert.equal(pickupName("Foster", "Foster Farmers Market"),
      "Foster Farmers Market");
    assert.equal(pickupName("Warwick", "Warwick Night Market"),
      "Warwick Night Market");
    assert.equal(pickupName("Foster", "Fosterville Market"),
      "Foster · Fosterville Market");
    assert.equal(pickupName("Scituate", "Drop site"), "Scituate · Drop site");
    assert.equal(pickupName("", "Drop site"), "Drop site");
  });

  it("keeps a second street line and leaves out what is missing", () => {
    assert.deepEqual(addressLines({
      name: "Rocky Point Park", street: "1 Rocky Point Avenue",
      street2: "Gate B", city: "Warwick", state: "RI",
    }), [
      "Rocky Point Park", "1 Rocky Point Avenue", "Gate B", "Warwick, RI",
    ]);
  });

  it("has no address for a place it does not know", () => {
    assert.deepEqual(pickupParts(drop).address, []);
  });
});
