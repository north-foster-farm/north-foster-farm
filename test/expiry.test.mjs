import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { expired, hideExpired } from "../assets/scripts/expiry/expiry.js";

const end = "2026-10-18T00:00:00-04:00";

// A page with the market band, due out at `ends`, and the off-season
// band, built hidden and due in at the same moment.
const page = (ends) => {
  const band = { dataset: { hideFrom: ends }, hidden: false };
  const ways = { dataset: { showFrom: ends }, hidden: true };

  return {
    band,
    ways,
    root: {
      querySelectorAll: (selector) => ({
        "[data-hide-from]": [band],
        "[data-show-from]": [ways],
      })[selector],
    },
  };
};

describe("expiry", () => {
  it("keeps a note until its moment", () => {
    assert.equal(expired(end, Date.parse("2026-10-17T23:59:59-04:00")),
      false);
  });

  it("hides it from that moment on", () => {
    assert.equal(expired(end, Date.parse("2026-10-18T00:00:00-04:00")),
      true);
    assert.equal(expired(end, Date.parse("2027-01-01T12:00:00-05:00")),
      true);
  });

  it("keeps a note whose moment cannot be read", () => {
    assert.equal(expired("", 0), false);
    assert.equal(expired("soon", Date.now()), false);
    assert.equal(expired(undefined, Date.now()), false);
  });
});

describe("the market band giving way to the off-season band", () => {
  const ends = "2026-10-26T00:00:00-04:00";

  it("shows the market band alone through the last day", () => {
    const { band, ways, root } = page(ends);

    hideExpired(root, Date.parse("2026-10-25T23:59:59-04:00"));
    assert.equal(band.hidden, false);
    assert.equal(ways.hidden, true);
  });

  it("swaps them at midnight farm time on the next day", () => {
    const { band, ways, root } = page(ends);

    hideExpired(root, Date.parse("2026-10-26T00:00:00-04:00"));
    assert.equal(band.hidden, true);
    assert.equal(ways.hidden, false);
  });

  it("swaps them in a page loaded long after", () => {
    const { band, ways, root } = page(ends);

    hideExpired(root, Date.parse("2027-03-01T09:00:00-05:00"));
    assert.equal(band.hidden, true);
    assert.equal(ways.hidden, false);
  });

  it("leaves a band whose moment cannot be read as built", () => {
    const { band, ways, root } = page("");

    hideExpired(root, Date.now());
    assert.equal(band.hidden, false);
    assert.equal(ways.hidden, true);
  });
});
