// #568: the home page's seasonal bands, picked in the browser. The
// build prints the market band with every market in data/series.json,
// each with its season as markets.html writes it (market/starts.html,
// market/ends.html: midnight farm time on its first day, and on the
// day after its last), and the three ways band beside it. pickSeason
// shows each market through its season, the band while a market that
// isn't a winter one runs, and the ways otherwise.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { inSeason, pickSeason } from "../assets/scripts/expiry/expiry.js";
import { addDays, instant } from "../assets/scripts/order/lib/zoned.mjs";

const ZONE = JSON.parse(readFileSync(
  new URL("../data/delivery.json", import.meta.url))).timeZone;
const SERIES = JSON.parse(readFileSync(
  new URL("../data/series.json", import.meta.url))).series;
const MARKETS = SERIES.filter((s) => s.kind === "market");

const midnight = (iso) => instant(iso, 0, 0, ZONE).toISOString();
const at = (iso, hour = 10) => instant(iso, hour, 0, ZONE).getTime();

const el = (dataset, hidden = false, children = []) => ({
  dataset, hidden, querySelectorAll: () => children,
});

// The home page as built on `built` (YYYY-MM-DD), with its own day's
// pick: what that day rules out is hidden and marked.
const page = (built) => {
  const markets = MARKETS.map((m) => {
    const on = m.start <= built && m.end >= built;
    const dataset = {
      seasonFrom: midnight(m.start),
      seasonUntil: midnight(addDays(m.end, 1)),
      series: m.code,
      ...(m.winter ? { winter: "" } : {}),
      ...(on ? {} : { expiry: "hid" }),
    };

    return { code: m.code, ...el(dataset, !on) };
  });
  const season = MARKETS.some((m) => !m.winter && m.start <= built
    && m.end >= built);
  const band = el(season ? {} : { expiry: "hid" }, !season, markets);
  const ways = el(season ? { expiry: "hid" } : {}, season);
  const root = {
    querySelector: (selector) => ({
      "[data-season-band]": band,
      "[data-season-ways]": ways,
    })[selector] || null,
  };
  const shown = () => markets.filter((m) => !m.hidden).map((m) => m.code)
    .sort();

  return { band, ways, markets, root, shown };
};

// Today's data, so the test follows the farm's markets as they change.
const running = (iso) => MARKETS
  .filter((m) => m.start <= iso && m.end >= iso).map((m) => m.code).sort();
const seasonOn = (iso) => MARKETS
  .some((m) => !m.winter && m.start <= iso && m.end >= iso);
const lastClose = MARKETS.filter((m) => !m.winter).map((m) => m.end)
  .sort().at(-1);
// A Saturday in September of the season in the data.
const september = (() => {
  let d = `${lastClose.slice(0, 4)}-09-01`;

  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 6) d = addDays(d, 1);

  return d;
})();

describe("a market's season", () => {
  const market = el({
    seasonFrom: "2026-06-06T00:00:00-04:00",
    seasonUntil: "2026-09-27T00:00:00-04:00",
  });

  it("runs from midnight on its first day to midnight after its last",
    () => {
      assert.equal(inSeason(market, Date.parse("2026-06-05T23:59:59-04:00")),
        false);
      assert.equal(inSeason(market, Date.parse("2026-06-06T00:00:00-04:00")),
        true);
      assert.equal(inSeason(market, Date.parse("2026-09-26T23:59:59-04:00")),
        true);
      assert.equal(inSeason(market, Date.parse("2026-09-27T00:00:00-04:00")),
        false);
    });

  it("is open at an end it cannot read", () => {
    assert.equal(inSeason(el({ seasonFrom: "2026-06-06T00:00:00-04:00" }),
      Date.parse("2099-01-01T00:00:00-05:00")), true);
  });
});

describe("the home page's seasonal bands (#568)", () => {
  it("shows the market band on a September Saturday, in a page built "
    + "after the season", () => {
    assert.ok(seasonOn(september), "the data has a September market");

    const p = page("2026-11-12");

    assert.equal(p.band.hidden, true);
    assert.equal(pickSeason(p.root, at(september)), true);
    assert.equal(p.band.hidden, false);
    assert.equal(p.ways.hidden, true);
    assert.deepEqual(p.shown(), running(september));
  });

  it("shows the ways the day after the last close, in a page built in "
    + "the season", () => {
    const p = page(september);
    const after = addDays(lastClose, 1);

    assert.equal(p.band.hidden, false);
    // Still the market band at the last minute of the last day.
    pickSeason(p.root, instant(after, 0, 0, ZONE).getTime() - 1);
    assert.equal(p.band.hidden, false);
    assert.equal(p.ways.hidden, true);

    assert.equal(pickSeason(p.root, at(after, 0)), seasonOn(after));
    assert.equal(p.band.hidden, !seasonOn(after));
    assert.equal(p.ways.hidden, seasonOn(after));
  });

  it("keeps the ways band while a winter market runs alone (#544)", () => {
    const winter = MARKETS.find((m) => m.winter);
    const p = page(september);

    assert.ok(winter, "the data has a winter market");
    assert.equal(seasonOn(winter.start), false);
    assert.equal(pickSeason(p.root, at(winter.start)), false);
    assert.equal(p.band.hidden, true);
    assert.equal(p.ways.hidden, false);
  });

  it("lists a winter market beside a season one while both run", () => {
    const winter = { code: "WNTR", ...el({
      seasonFrom: "2026-09-01T00:00:00-04:00",
      seasonUntil: "2027-05-01T00:00:00-04:00", winter: "", expiry: "hid",
    }, true) };
    const summer = { code: "SMMR", ...el({
      seasonFrom: "2026-06-01T00:00:00-04:00",
      seasonUntil: "2026-10-01T00:00:00-04:00", expiry: "hid",
    }, true) };
    const band = el({ expiry: "hid" }, true, [summer, winter]);
    const ways = el({}, false);
    const root = { querySelector: (s) => (s === "[data-season-band]"
      ? band : ways) };

    pickSeason(root, Date.parse("2026-09-15T10:00:00-04:00"));
    assert.equal(band.hidden, false);
    assert.equal(summer.hidden, false);
    assert.equal(winter.hidden, false);
    assert.equal(ways.hidden, true);

    // Its season market gone, the winter one goes with the band.
    pickSeason(root, Date.parse("2026-10-15T10:00:00-04:00"));
    assert.equal(band.hidden, true);
    assert.equal(ways.hidden, false);
  });

  it("follows the staging clock there and back", () => {
    const p = page("2026-11-12");

    for (const [day, season] of [[september, true], ["2026-11-12", false],
      [september, true], ["2026-01-15", false]]) {
      assert.equal(pickSeason(p.root, at(day)), season, day);
      assert.equal(p.band.hidden, !season, day);
      assert.equal(p.ways.hidden, season, day);
    }
  });

  // No flash: a page read on its own build day is left as built.
  it("changes nothing on the build's own day", () => {
    for (const built of [september, "2026-11-12", "2026-06-01"]) {
      const p = page(built);
      const before = [p.band.hidden, p.ways.hidden, p.shown()];

      pickSeason(p.root, at(built, 12));
      assert.deepEqual([p.band.hidden, p.ways.hidden, p.shown()], before,
        built);
    }
  });

  it("never shows a market another rule hid", () => {
    const p = page(september);
    const [first] = running(september);
    const skipped = p.markets.find((m) => m.code === first);

    // The schedule's skip (wireSkips, schedule.js) hides it and clears
    // the mark.
    skipped.hidden = true;
    delete skipped.dataset.expiry;
    pickSeason(p.root, at("2026-12-05"));
    pickSeason(p.root, at(september));
    assert.equal(skipped.hidden, true);
  });

  it("leaves a page with no market band alone", () => {
    assert.equal(pickSeason({ querySelector: () => null }, Date.now()), null);
  });
});

// The production build carries both bands and every market, and hides
// what its own day rules out, so the page paints the right band before
// any script runs: no flash in production.
const hasHugo = spawnSync("hugo", ["version"]).status === 0;

describe("the home bands as production builds them (#568)", {
  skip: !hasHugo,
}, () => {
  let out;
  let home;

  before(() => {
    out = mkdtempSync(join(tmpdir(), "nff-season-build-"));

    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-d", out], {
      cwd: join(import.meta.dirname, ".."), encoding: "utf8",
    });

    assert.equal(run.status, 0, run.stderr);
    home = readFileSync(join(out, "index.html"), "utf8");
  });

  after(() => rmSync(out, { recursive: true, force: true }));

  const tag = (marker) => {
    const found = home.match(new RegExp(`<[^>]* ${marker}[ >][^>]*>`));

    assert.ok(found, marker);

    return found[0];
  };

  it("carries both bands, and every market with its season", () => {
    tag("data-season-band");
    tag("data-season-ways");
    for (const m of MARKETS) {
      const li = home.match(new RegExp(
        `<li class="place"[^>]*data-series="${m.code}"[^>]*>`));

      assert.ok(li, m.name);
      assert.match(li[0], new RegExp(
        `data-season-from="${m.start}T00:00:00-0[45]:00"`), m.name);
      assert.match(li[0], new RegExp(`data-season-until="${
        addDays(m.end, 1)}T00:00:00-0[45]:00"`), m.name);
      assert.equal(li[0].includes("data-winter"), !!m.winter, m.name);
    }
  });

  it("shows only the band the build's own day picks", () => {
    const built = tag("data-season-band").match(/data-built="([^"]+)"/)[1];
    const on = seasonOn(built);
    const shown = (t) => !/ hidden[ >]/.test(t);

    assert.equal(shown(tag("data-season-band")), on, built);
    assert.equal(shown(tag("data-season-ways")), !on, built);
    // What it hid, it marked, for the browser to show again.
    for (const t of [tag("data-season-band"), tag("data-season-ways")]) {
      if (!shown(t)) assert.match(t, /data-expiry="hid"/);
    }
  });
});
