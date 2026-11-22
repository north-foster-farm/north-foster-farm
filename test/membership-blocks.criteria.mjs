// Criteria tests for #840, phase 8 of the split of account/main.js
// (docs/refactors/account.md, "Phase 8: membership"), held out of `npm
// test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/membership-blocks.criteria.mjs test/membership-blocks.test.mjs
//
// All three criteria are of the new-module kind: they fail on `next`,
// where account/lib/blocks.mjs does not exist, and pass once the phase
// draws the Membership pane's decisions out. Nothing retires: the
// membership tests that stay green test libraries that do not move.
//
// Contract (the design names the functions and their module, not
// their arguments or what they return; these are the test agent's
// choice; the call shape may be adapted, the expected values may
// not). `view` is /api/membership's answer ({ member, hosts }).
//
//   groupBlocks(view)  -> [[group, hosted]], hosted being the host's
//                         record of that group, or nothing
//   leaves(view)       -> whether Leave the group shows
//   membersHeading(members) -> the list's heading

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupBlocks, leaves, membersHeading,
} from "../assets/scripts/account/lib/blocks.mjs";
import { assertPure } from "./pure-module.mjs";

const group = (key) => ({ key, group: { name: key } });
const hosted = (key) => ({ ...group(key), members: [], qr: { link: key } });

// Box 1 of #840.
describe("groupBlocks", () => {
  it("puts the member's own group first, with its host's part when they "
    + "host it, then each other group they host", () => {
    const own = group("vff");
    const hostsOwn = hosted("vff");
    const other = hosted("gym2");
    const keys = (blocks) => blocks.map(([g, h]) => [g.key, h ? h.key : null]);

    assert.deepEqual(keys(groupBlocks({ member: own, hosts: [other,
      hostsOwn] })), [["vff", "vff"], ["gym2", "gym2"]]);
    assert.equal(groupBlocks({ member: own, hosts: [other, hostsOwn] })[0][1],
      hostsOwn, "the host's part of their own group");
    assert.deepEqual(keys(groupBlocks({ member: own, hosts: [other] })),
      [["vff", null], ["gym2", "gym2"]]);
    assert.deepEqual(keys(groupBlocks({ member: null, hosts: [other,
      hosted("lake")] })), [["gym2", "gym2"], ["lake", "lake"]]);
  });
});

// Box 2 of #840.
describe("leaves", () => {
  it("is false with no membership and false for a host who is a member "
    + "only by hosting", () => {
    assert.equal(leaves({ member: null, hosts: [hosted("gym2")] }), false);
    assert.equal(leaves({ member: { ...group("vff"), byHost: true },
      hosts: [hosted("vff")] }), false);
    assert.equal(leaves({ member: group("vff"), hosts: [] }), true);
  });
});

// Box 3 of #840.
describe("membersHeading", () => {
  it("counts the members, and reads Members alone with none", () => {
    assert.equal(membersHeading([{}, {}, {}]), "Members (3)");
    assert.equal(membersHeading([{}]), "Members (1)");
    assert.equal(membersHeading([]), "Members");
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/blocks.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/blocks.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "Element"] });
  });
});
