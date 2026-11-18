// The refresh date-lists.js sets for the earliest scheduled cutoff,
// and the closed group rounds it drops (#540's review). These rode in
// with the pickup-day picker and stayed on `next` when it was parked
// (#617): earliestCutoff and stillOpen now live in lib/scheduled.mjs.
// The implementer's own tests, carried over from the picker's.

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { DateLists } from "../assets/scripts/order/date-lists.js";
import {
  earliestCutoff, scheduledChoices, stillOpen,
} from "../assets/scripts/order/lib/scheduled.mjs";

const entry = (occurrence, date, cutoff, extra) => ({
  occurrence, date, cutoff, ...extra,
});
const LIST = scheduledChoices([
  entry("VFVQ-261114", "2026-11-14", "2026-11-14T04:59:00.000Z",
    { series: "VFVQ", name: "Drop site" }),
  entry("WAC5-261115", "2026-11-15", "2026-11-15T04:59:00.000Z",
    { series: "WAC5", name: "Foster Farmers Market" }),
  entry("W9MF-261121", "2026-11-21", "2026-11-21T04:59:00.000Z",
    { series: "W9MF", name: "Thanksgiving Prep" }),
]);
const [drop, foster, popup] = LIST;
const AT = Date.parse("2026-11-13T12:00:00Z");

const form = () => ({
  querySelector: () => null, querySelectorAll: () => [],
});

describe("the refresh at the earliest cutoff (date-lists.js)", () => {
  afterEach(() => mock.timers.reset());

  it("finds the earliest cutoff in a list", () => {
    assert.equal(earliestCutoff(LIST), Date.parse(drop.cutoff));
    assert.equal(earliestCutoff([{ cutoff: "" }]), null);
    assert.equal(earliestCutoff([]), null);
  });

  it("refreshes the lists once the earliest pickup has closed", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: AT });

    const lists = new DateLists(form(), () => {});

    lists.lists = { scheduled: LIST, delivery: [] };
    lists.refresh = mock.fn(async () => true);
    lists.tick();

    mock.timers.tick(Date.parse(drop.cutoff) - Date.now());
    assert.equal(lists.refresh.mock.callCount(), 0, "not before it closes");
    mock.timers.tick(1000);
    assert.equal(lists.refresh.mock.callCount(), 1);
  });

  it("keeps the entries still open, and those with no cutoff", () => {
    const now = Date.parse(drop.cutoff);

    assert.deepEqual(stillOpen(LIST, now).map((d) => d.value),
      LIST.slice(1).map((d) => d.value), "closes at its cutoff");
    assert.deepEqual(stillOpen([{ cutoff: "" }], now), [{ cutoff: "" }]);
    assert.deepEqual(stillOpen(null, now), []);
  });

  // A group's round that closes with the page open: kept in `extra`,
  // its passed cutoff stayed the earliest and the lists refreshed
  // about once a second.
  it("drops a group's round once it closes, so it refreshes once", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: AT });

    const lists = new DateLists(form(), () => {});
    const round = { ...popup, occurrence: "R0ND-261113",
      value: "R0ND-261113", cutoff: "2026-11-13T11:59:00.000Z" };

    lists.extra = [round];
    lists.refresh = mock.fn(async () => true);
    lists.apply({ now: new Date(AT).toISOString(),
      scheduled: LIST.slice(1), delivery: [] });

    assert.deepEqual(lists.extra, []);
    assert.ok(!lists.lists.scheduled.some((d) => d.value === round.value));

    mock.timers.tick(60_000);
    assert.equal(lists.refresh.mock.callCount(), 0,
      "no refresh for the round that has closed");
    mock.timers.tick(Date.parse(foster.cutoff) - Date.now() + 1000);
    assert.equal(lists.refresh.mock.callCount(), 1,
      "one at the next pickup's cutoff");
  });

  it("joins only open rounds when a group's code is accepted", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: AT });

    const lists = new DateLists(form(), () => {});
    const closed = { ...popup, occurrence: "R0ND-261113",
      cutoff: "2026-11-13T11:59:00.000Z" };

    lists.setExtra([closed, popup]);
    assert.deepEqual(lists.extra, [popup]);
  });
});
