// #397: the home page's three ways band (James's D-354-31 wording),
// read off the built HTML. Where Hugo is not installed (CI's test job),
// CI's build job builds the page and this is skipped.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const hasHugo = spawnSync("hugo", ["version"]).status === 0;
const data = (name) =>
  JSON.parse(readFileSync(join(root, "data", `${name}.json`), "utf8"));

const FACT = /<li class="place-fact place-(\w+)"[\s\S]*?<\/li>/g;
const text =(html) => html
  .replace(/<svg[\s\S]*?<\/svg>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replaceAll(String.fromCharCode(0xa0), " ")
  .replaceAll(String.fromCharCode(0x2060), "")
  .replace(/\s+/g, " ")
  .trim();

describe("home page ways band", { skip: !hasHugo }, () => {
  let out;
  let cards;
  let band;

  before(() => {
    out = mkdtempSync(join(tmpdir(), "nff-ways-"));

    const run = spawnSync("hugo", ["--gc", "--quiet", "--environment",
      "production", "-d", out], { cwd: root, encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);

    const html = readFileSync(join(out, "index.html"), "utf8");

    band = html.match(/<div class="places ways home-band[\s\S]*?<template/)[0];
    cards = band.split('<li class="place place-way').slice(1)
      .map((card) => ({
        name: text(card.match(/<h3[\s\S]*?<\/h3>/)[0]),
        line: text(card.match(/<p class="place-tagline">[\s\S]*?<\/p>/)[0]),
        facts: [...card.matchAll(FACT)].map((m) => [m[1], text(m[0])]),
      }));
  });

  after(() => rmSync(out, { recursive: true, force: true }));

  it("leads and heads as James wrote", () => {
    assert.match(text(band.match(/home-eyebrow[\s\S]*?<\/p>/)[0]),
      /No off-season/);
    assert.match(text(band.match(/home-title[\s\S]*?<\/h2>/)[0]),
      /Three ways to get your order/);
  });

  it("has the three cards with his lines", () => {
    assert.deepEqual(cards.map((c) => [c.name, c.line]), [
      ["On-farm pickup",
        "Choose a day and time to get your order right here at the farm"],
      ["Pickup days", "Order in advance and get your order at any " +
        "upcoming market, pop-up, or drop site"],
      ["Delivery",
        "Our farm-to-doorstep service: delivery to your front door, " +
        "every week"],
    ]);
    assert.ok(!band.includes("get your order from at"));
  });

  it("reads where, when and cost from the data", () => {
    const company = data("company").address;
    const terms = data("delivery");
    const drop = data("series").series.find((s) => s.kind === "drop-site");
    // The location's short address, which a series may override.
    const dropShort = drop.short || data("locations").locations
      .find((l) => l.code === drop.location).short;
    const [onfarm, scheduled, delivery] = cards.map((c) =>
      Object.fromEntries(c.facts));

    assert.equal(onfarm.where,
      `${company.short}, ${company.city}, ${company.state}`);
    assert.equal(onfarm.when, undefined);
    assert.equal(onfarm.note, "No minimum, no fee");
    assert.equal(scheduled.where, dropShort);
    assert.match(scheduled.when, /^Saturdays, 10:00 – 11:00 AM$/);
    assert.equal(scheduled.note, "No minimum, no fee");
    assert.match(delivery.when,
      /^Every Thursday, 10:00 AM – 4:00 PM$/);
    assert.equal(terms.delivery.window, "10:00 AM – 4:00 PM");
    assert.equal(delivery.where,
      "Most of central Rhode Island and parts of eastern Connecticut");
    // The figures follow money.changes by the build's date, so the
    // test holds the shape, and the page's figures to the data's.
    const figures = [terms.money, ...terms.money.changes]
      .map((m) => m.deliveryMinimum);
    const [, min, fee] = delivery.note
      .match(/^\$(\d+) minimum, \$(\d+) fee$/);

    assert.ok(figures.includes(Number(min)));
    assert.equal(Number(fee), terms.money.deliveryFee);
  });
});
