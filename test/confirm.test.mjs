import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { confirmation, confirmed } from "../bin/confirm.mjs";

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
});
