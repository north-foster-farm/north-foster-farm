// Pawtucket Farmers Market (#544): a market on Tuesdays and four
// Saturday pop-ups at one location, offered for pickup like the
// others. Every time is in the afternoon: a 2026-11-11 screenshot read
// "12:00 – 5:00 AM", so these pin PM.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { scheduleFor } from "../bin/dev-schedule.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import { allDates } from "../assets/scripts/order/lib/dates.mjs";
import { chosenText } from "../assets/scripts/order/lib/picker.mjs";
import {
  checkSchedule, parseSchedule,
} from "../assets/scripts/order/lib/schedule.mjs";
import {
  pickupName, scheduledChoice,
} from "../assets/scripts/order/lib/scheduled.mjs";
import {
  addDays, instant, today,
} from "../assets/scripts/order/lib/zoned.mjs";

const ZONE = "America/New_York";
const ny = (iso, hour = 9) => instant(iso, hour, 0, ZONE);
const { model } = terms;
// The markets that make a market season on the home page (#544).
const seasonMarkets = model.series
  .filter((s) => s.kind === "market" && !s.winter);
const MARKET = "H3TQ";
const POPUPS = {
  W9MF: ["2026-11-21", "Thanksgiving Prep"],
  C4ZR: ["2027-01-16", "Breaking Out of Hermit Mode"],
  E8NJ: ["2027-03-27", "Easter Market"],
  K2VB: ["2027-04-17", "Earth Day Cleanup & Eco Fair"],
};
const CODES = new Set([MARKET, ...Object.keys(POPUPS)]);
const OURS = (x) => CODES.has(x.series || x.code);

// The schedule as the functions read it: windows with the lines on.
const asRead = (text) => {
  const { windows, lines } = parseSchedule(text);

  return Object.assign(windows, { lines });
};
const SCHEDULE = scheduleFor("2026-11-01", "2027-05-01");
const withoutPawtucket = (text) => text.split("\n")
  .filter((l) => !CODES.has(l.split(" ")[1])).join("\n");

describe("Pawtucket in the model (#544)", () => {
  it("is one location in Pawtucket, inside Jordan's Jungle", () => {
    const loc = model.location("P7KX");

    assert.equal(loc.name, "Jordan's Jungle");
    assert.equal(loc.street, "545 Pawtucket Ave");
    assert.equal(loc.city, "Pawtucket");
    assert.equal(loc.zip, "02860");
    for (const code of CODES) {
      assert.equal(model.seriesOf(code).location, "P7KX", code);
    }
  });

  it("holds the market on Tuesdays, 12:00 to 4:00 PM, Nov to Apr", () => {
    const s = model.seriesOf(MARKET);

    assert.equal(s.kind, "market");
    assert.equal(s.name, "Pawtucket Farmers Market");
    assert.equal(s.weekday, 2);
    assert.equal(s.start, "2026-11-10");
    assert.equal(s.end, "2027-04-27");
    assert.equal(s.window, "12:00 – 4:00 PM");
    assert.equal(s.closesHour, 16);
  });

  it("holds each pop-up on its own Saturday, 12:00 to 5:00 PM", () => {
    for (const [code, [date, name]] of Object.entries(POPUPS)) {
      const s = model.seriesOf(code);

      assert.equal(s.kind, "pop-up", code);
      assert.equal(s.name, name);
      assert.equal(s.start, date);
      assert.equal(s.end, date);
      assert.equal(s.weekday, 6, `${name} is on a Saturday`);
      assert.equal(s.window, "12:00 – 5:00 PM", name);
      assert.doesNotMatch(s.window, /AM/, name);
      assert.equal(s.closesHour, 17);
    }
  });
});

describe("Pawtucket on the order page's pickup days (#544)", () => {
  const pickups = (now) => allDates(now, terms, asRead(SCHEDULE))
    .scheduled.filter(OURS);

  it("offers the Tuesday and the Thanksgiving pop-up from Nov 11", () => {
    const got = pickups(ny("2026-11-11"));

    assert.deepEqual(got.map((d) => d.occurrence),
      ["H3TQ-261117", "W9MF-261121"]);

    const [market, popup] = got.map(scheduledChoice);

    // The picker's words for them (#540).
    assert.equal(market.window, "12:00 – 4:00 PM");
    assert.equal(chosenText(market),
      "Pickup chosen: 12:00 to 4:00 PM, Pawtucket Farmers Market");
    assert.equal(chosenText(popup),
      "Pickup chosen: 12:00 to 5:00 PM, Pawtucket, Thanksgiving Prep");
    assert.equal(pickupName(market.town, market.name),
      "Pawtucket Farmers Market", "the name says its town");
    assert.equal(pickupName(popup.town, popup.name),
      "Pawtucket · Thanksgiving Prep");
    for (const d of got) assert.equal(d.short, "Jordan's Jungle, Pawtucket");
  });

  it("offers each pop-up when it comes into the horizon, timed PM", () => {
    for (const [code, [date, name]] of Object.entries(POPUPS)) {
      const got = pickups(ny(addDays(date, -3)))
        .find((d) => d.series === code);

      assert.ok(got, `${name} is offered three days ahead`);
      assert.equal(got.occurrence.slice(0, 4), code);
      assert.equal(got.date, date);
      assert.equal(got.name, name);
      assert.equal(got.window, "12:00 – 5:00 PM");
    }
  });

  it("offers every Tuesday of the season, and none after it", () => {
    const tuesdays = [];

    for (let d = "2026-11-10"; d <= "2027-05-31"; d = addDays(d, 7)) {
      const got = pickups(ny(addDays(d, -1)))
        .filter((x) => x.series === MARKET).map((x) => x.date);

      if (got.includes(d)) tuesdays.push(d);
    }
    assert.equal(tuesdays[0], "2026-11-10");
    assert.equal(tuesdays.at(-1), "2027-04-27");
    assert.equal(tuesdays.length, 25);
  });
});

describe("check:schedule with Pawtucket (#544)", () => {
  const check = (text, now) => checkSchedule(text, {
    now, timeZone: terms.timeZone, model,
  });

  it("passes with the Pawtucket lines", () => {
    const got = check(SCHEDULE, ny("2026-11-11"));

    assert.deepEqual(got.errors, []);
    assert.ok(got.lines.some((l) => l.code === MARKET));
  });

  it("fails without them once a Pawtucket date is in the horizon", () => {
    const got = check(withoutPawtucket(SCHEDULE), ny("2026-11-11"));

    assert.equal(got.ok, false);
    assert.ok(got.errors.includes("2026-11-17: H3TQ (Pawtucket Farmers " +
      'Market) needs a line: "2026-11-17 H3TQ pickup", attend or skip.'),
    got.errors.join("\n"));
    assert.ok(got.errors.includes("2026-11-21: W9MF (Thanksgiving Prep) " +
      'needs a line: "2026-11-21 W9MF pickup", attend or skip.'));
  });

  it("passes without them while no Pawtucket date is in reach", () => {
    const early = scheduleFor("2026-10-01", "2026-11-09");

    assert.deepEqual(check(withoutPawtucket(early), ny("2026-10-20"))
      .errors, []);
  });
});

const hasHugo = spawnSync("hugo", ["version"]).status === 0;
// The home band and the map show a series only in its season.
const inSeason = today(new Date(), ZONE) <= "2027-04-27";

describe("Pawtucket on built pages (#544)", {
  skip: !hasHugo || !inSeason,
}, () => {
  const root = join(import.meta.dirname, "..");
  let out;
  const html = (p) => readFileSync(join(out, p, "index.html"), "utf8");
  const text = (p) => html(p).replace(/<[^>]+>/g, " ")
    .replaceAll("&#39;", "'").replaceAll("&amp;", "&")
    .replaceAll(String.fromCharCode(0xa0), " ").replace(/\s+/g, " ");

  before(() => {
    out = mkdtempSync(join(tmpdir(), "nff-pawtucket-build-"));

    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-d", out], { cwd: root, encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);
  });

  after(() => rmSync(out, { recursive: true, force: true }));

  it("lists the market on the About page, Tuesdays in the afternoon", () => {
    assert.match(text("about"), new RegExp("Pawtucket Farmers Market " +
      "Tuesdays, 12:00 – 4:00 PM November through April " +
      "Jordan's Jungle 545 Pawtucket Ave, Pawtucket, RI 02860"));
  });

  // Option (c) on #548: a winter market alone is no market season, so
  // the home page keeps the ways band, shown, with the market band
  // built hidden for the browser to pick at view time (#568). Its
  // Pickup days card fills the places open from /api/dates.
  it("keeps the home page's ways band while only it runs", {
    skip: today(new Date(), ZONE) < "2026-11-10"
      || seasonMarkets.some((m) => m.start <= today(new Date(), ZONE)
        && m.end >= today(new Date(), ZONE)),
  }, () => {
    const page = html("");

    assert.match(page, new RegExp('class="places home-band[^"]*" '
      + 'data-season-band[^>]* hidden data-expiry="hid">'));
    assert.match(page,
      /<div class="places ways home-band[^"]*" data-season-ways>/);
    assert.match(page, /data-scheduled-ways/);
  });

  it("is a winter market, so the season's last market stays Foster's",
    () => {
      assert.equal(model.seriesOf(MARKET).winter, true);
      assert.match(text("news/three-quarters-of-the-way"),
        /wrapped up in Foster on October 25/);
    });

  it("pins it on the map, with its card and directions", () => {
    const page = html("");
    const card = text("").match(new RegExp("Jordan's Jungle " +
      "Pawtucket Farmers Market,.*?Market Instagram"));

    assert.match(page, /data-map-slug="place-jordans-jungle"/);
    assert.ok(card, "the row and its card");
    assert.match(card[0], new RegExp("Pawtucket Farmers Market Tuesdays, " +
      "12:00 – 4:00 PM November 10 to April 27"));
    // A pop-up leaves the card once its day has passed.
    if (today(new Date(), ZONE) < "2027-04-17") {
      assert.match(card[0], new RegExp("Earth Day Cleanup & Eco Fair " +
        "Saturday, April 17, 12:00 – 5:00 PM"));
    }
    assert.match(card[0], /Where 545 Pawtucket Ave, Pawtucket, RI 02860/);
    assert.doesNotMatch(card[0], /\d AM/);
    assert.ok(page.includes("destination=Jordan%27s&#43;Jungle%2C&#43;545" +
      "&#43;Pawtucket&#43;Ave%2C&#43;Pawtucket%2C&#43;RI&#43;02860"));
  });
});
