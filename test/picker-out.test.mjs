// Criteria tests for #617: the pickup-day picker (#540) out of `next`.
// Held out of `npm test` by its name until the picker is out; the
// implementer turns it on with
//
//   git mv test/picker-out.criteria.mjs test/picker-out.test.mjs
//
// The picker's own unit tests, test/picker.test.mjs, move with it to
// `parked/pickup-picker` and leave `next`: they import the modules
// this file says are gone. The browser's side (no week strip, no
// picker markup, styles or scripts) is e2e/picker-out.spec.mjs.
//
// Its test of production's lapsed line ("<day>: <name>, <town>,
// <window>") went with #703: the lapsed dialog shows the pickup-days
// layout now (e2e/pickup-days.spec.mjs).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;

// The picker's modules as #540 added them.
const MODULES = [
  "assets/scripts/order/lib/picker.mjs",
  "assets/scripts/order/pickup-picker.js",
  "assets/styles/components/_pickup-picker.scss",
  "layouts/partials/order/pickup-picker.html",
];

const files = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name))
    : [join(dir, e.name)]));

describe("the picker out of next (#617)", () => {
  it("the picker's modules are gone", () => {
    for (const path of MODULES) {
      assert.equal(existsSync(join(ROOT, path)), false, `${path} is gone`);
    }
    // And nothing the site builds from still reaches for them.
    const uses = /pickup-picker|lib\/picker\.mjs|PickupPicker/;

    for (const path of [...files("assets"), ...files("layouts")]) {
      if (!/\.(m?js|scss|html)$/.test(path)) continue;
      assert.doesNotMatch(readFileSync(join(ROOT, path), "utf8"), uses,
        path);
    }
  });
});
