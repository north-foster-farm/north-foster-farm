import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GUARDED, confirmation, confirmed } from "../bin/confirm.mjs";

const cancel = { group: "orders", action: "cancel", rest: ["NFF-1"] };
// A terminal that types `answer`, and what it was asked.
const typing = (answer) => {
  const asked = [];

  return { asked, ask: async (q) => { asked.push(q); return answer; } };
};
const said = () => {
  const lines = [];

  return { lines, say: (line) => lines.push(line) };
};

describe("bin/nff's production confirmation (#268)", () => {
  it("names what each destructive command acts on", () => {
    assert.deepEqual(confirmation(cancel),
      { does: "cancel and maybe refund order", phrase: "NFF-1" });
    assert.equal(confirmation({ group: "orders", action: "refund",
      rest: ["NFF-1"] }).phrase, "NFF-1");
    assert.equal(confirmation({ group: "orders", action: "delete",
      rest: ["NFF-1"] }).phrase, "NFF-1");
    assert.equal(confirmation({ group: "customers", action: "delete",
      rest: ["pat@example.com"] }).phrase, "pat@example.com");
    assert.equal(confirmation({ group: "stock", action: "set",
      rest: ["NFF-CHK-EGG-LG", "5"] }).phrase, "NFF-CHK-EGG-LG");
  });

  it("names the customer, pass or sweep the other commands act on", () => {
    const phrase = (group, action, rest = [], flags = {}) =>
      confirmation({ group, action, rest, flags })?.phrase;

    assert.equal(phrase("orders", "move", ["NFF-1", "2026-10-30"]), "NFF-1");
    assert.equal(phrase("customers", "set", ["a@example.com", "x=1"]),
      "a@example.com");
    assert.equal(phrase("address", "deny", ["a@example.com"]),
      "a@example.com");
    assert.equal(phrase("passes", "revoke", ["PASS-1"]), "PASS-1");
    assert.equal(phrase("maintenance", "on"), "maintenance on");
    assert.equal(phrase("schedule", "set", ["file.json"]), "schedule set");
    assert.equal(phrase("jobs", "run"), "jobs run");
    assert.equal(phrase("audience", "sync"), "audience sync");
    assert.equal(phrase("audience", "sync", [], { "dry-run": true }),
      undefined);
  });

  it("guards square deletions pause and resume, not status", () => {
    const phrase = (word) => confirmation({
      group: "square", action: "deletions", rest: word ? [word] : [],
    })?.phrase;

    assert.equal(phrase("pause"), "square deletions");
    assert.equal(phrase("resume"), "square deletions");
    assert.equal(phrase("status"), undefined);
    assert.equal(phrase(), undefined);
  });

  it("leaves reads, and a command with no target, alone", () => {
    for (const [group, action] of [["orders", "list"], ["orders", "show"],
      ["stock", "list"], ["customers", "show"], ["health", undefined]]) {
      assert.equal(confirmation({ group, action, rest: ["x"] }), null);
    }
    assert.equal(confirmation({ group: "orders", action: "cancel",
      rest: [] }), null);
  });

  it("asks for a sweep or a rename only when it is applied", () => {
    const sweep = { group: "jobs", action: "square" };
    const rename = { group: "customers", action: "rename",
      rest: ["a@example.com", "b@example.com"] };

    assert.equal(confirmation(sweep), null);
    assert.equal(confirmation({ ...sweep, flags: { apply: true } }).phrase,
      "jobs square");
    assert.equal(confirmation(rename), null);
    assert.equal(confirmation({ ...rename, flags: { apply: true } }).phrase,
      "a@example.com");
  });

  it("goes ahead on what was typed, and on nothing else", async () => {
    const yes = typing("NFF-1 ");

    assert.equal(await confirmed(cancel,
      { context: "production", ask: yes.ask }), true);
    assert.match(yes.asked[0], /Type "NFF-1" to go ahead/);

    const say = said();

    assert.equal(await confirmed(cancel,
      { context: "production", ask: typing("yes").ask, say: say.say }),
    false);
    assert.deepEqual(say.lines, ["Nothing changed."]);
  });

  it("does not ask off production, or with --yes", async () => {
    const never = typing("");

    for (const context of ["staging", "development", undefined]) {
      assert.equal(await confirmed(cancel, { context, ask: never.ask }), true);
    }
    assert.equal(await confirmed(cancel,
      { context: "production", flags: { yes: true }, ask: never.ask }), true);
    assert.deepEqual(never.asked, []);
  });

  it("refuses with no terminal and no --yes", async () => {
    const say = said();

    assert.equal(await confirmed(cancel,
      { context: "production", ask: null, say: say.say }), false);
    assert.match(say.lines[0], /pass --yes/);
    assert.equal(await confirmed(cancel,
      { context: "production", flags: { yes: true }, ask: null }), true);
  });

  it("is wired into bin/nff before any command runs", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../bin/nff", import.meta.url),
      "utf8");

    assert.ok(source.indexOf("await confirmed(")
      < source.indexOf("switch (`${group} ${action}`)"));
  });

  it("covers every command in bin/nff that is not on the read list",
    async () => {
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(new URL("../bin/nff", import.meta.url),
        "utf8");
      const switchBody = source.slice(
        source.indexOf("switch (`${group} ${action}`)"));
      const commands = [...switchBody.matchAll(/^ {2}case "([^"]+)":/gm)]
        .map((m) => m[1]);
      // Commands that change nothing in the stores, or that ask for
      // themselves (sessions end-all) or sit behind another gate.
      const harmless = new Set([
        "customers list", "customers show", "customers quiet",
        "orders list", "orders occurrences", "orders show",
        "events undefined", "events new", "refunds check", "stock list",
        "schedule check", "passes issue", "passes list",
        "jobs history", "health", "alert test", "mail test-dev",
        "maintenance status", "maintenance links",
        "sessions end-all", "errors show",
        // Gone since #303: it only says to use audience import.
        "audience invite",
      ]);
      const open = commands.filter(
        (c) => !GUARDED.includes(c) && !harmless.has(c));

      assert.ok(commands.length > 40, `found ${commands.length} cases`);
      assert.deepEqual(open, [], "a bin/nff command is neither guarded " +
        "nor on the list of those that change nothing");
    });
});
