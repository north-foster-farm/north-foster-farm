import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gateCommand } from "../bin/gate.mjs";
import {
  createSession, isAllowed, sessionFor,
} from "../netlify/functions/lib/gate.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const NOW = new Date("2026-10-18T12:00:00Z");

const cli = async (stores, args, flags = {}, context = "branch-deploy") => {
  const lines = [];
  const [action, ...rest] = args;

  await gateCommand(action, rest, {
    stores, flags, context, now: NOW, out: (line) => lines.push(line),
  });

  return lines;
};

describe("bin/nff gate", () => {
  it("adds, lists and removes allowlist entries", async () => {
    const stores = testStores();

    assert.deepEqual(await cli(stores, ["allow", "list"]),
      ["The allowlist is empty."]);
    assert.deepEqual(await cli(stores, ["allow", "add", "Pat@Example.com"]),
      ["Added pat@example.com."]);
    await cli(stores, ["allow", "add", "@farm.org"]);
    assert.equal(await isAllowed(stores.gate, "sam@farm.org"), true);

    const listed = await cli(stores, ["allow", "list"]);

    assert.equal(listed.length, 2);
    assert.match(listed[0], /^@farm\.org {2}added 2026-10-18/);
    assert.deepEqual(await cli(stores, ["allow", "remove", "@farm.org"]),
      ["Removed @farm.org; ended 0 sessions."]);
    assert.equal(await isAllowed(stores.gate, "sam@farm.org"), false);
  });

  it("ends the sessions an entry let in when it is removed", async () => {
    const stores = testStores();

    await cli(stores, ["allow", "add", "pat@example.com"]);

    const id = await createSession(stores.gate, "pat@example.com", NOW);

    assert.deepEqual(
      await cli(stores, ["allow", "remove", "pat@example.com"]),
      ["Removed pat@example.com; ended 1 session."],
    );
    assert.equal(await sessionFor(stores.gate, id, NOW), null);
  });

  it("ends one address's sessions, or all with --yes", async () => {
    const stores = testStores();

    await cli(stores, ["allow", "add", "@example.com"]);

    const pat = await createSession(stores.gate, "pat@example.com", NOW);
    const sam = await createSession(stores.gate, "sam@example.com", NOW);

    assert.deepEqual(await cli(stores, ["sessions", "end", "PAT@example.com"]),
      ["Ended 1 session of pat@example.com."]);
    assert.equal(await sessionFor(stores.gate, pat, NOW), null);
    assert.notEqual(await sessionFor(stores.gate, sam, NOW), null);

    assert.deepEqual(await cli(stores, ["sessions", "end-all"]),
      ["Add --yes to end every session on this context."]);
    assert.notEqual(await sessionFor(stores.gate, sam, NOW), null);
    assert.deepEqual(await cli(stores, ["sessions", "end-all"], { yes: true }),
      ["Ended 1 session."]);
    assert.equal(await sessionFor(stores.gate, sam, NOW), null);
  });

  it("refuses a bad entry and a bad command", async () => {
    const stores = testStores();

    await assert.rejects(cli(stores, ["allow", "add", "not an address"]),
      /email address or a whole domain/);
    await assert.rejects(cli(stores, ["allow", "add"]), /Usage/);
    await assert.rejects(cli(stores, ["sessions", "end"]), /Usage/);
  });

  it("does not exist in production", async () => {
    await assert.rejects(
      cli(testStores(), ["allow", "list"], {}, "production"),
      /no access gate in production/,
    );
  });
});
