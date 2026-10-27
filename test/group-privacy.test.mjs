// What a member is told before any host sees them (#495, part 1): the
// privacy policy says the host sees the name, the email address and
// the date joined, and the code box says so while a group is on the
// order. No host sees a member's email address before these ship.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url),
  "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

const POLICY = [
  "If you use a group's code, you join that group, and its host can " +
    "see your name, your email address and when you joined.",
  "The host never sees your orders, your phone number, your address " +
    "or how you paid.",
  "You can leave a group at any time from your account page.",
];
const NOTE = "The group's host can see your name and email address.";

describe("what a member is told the host sees", () => {
  it("is in the privacy policy, under how information is used",
    async () => {
      const policy = flat(await read("content/privacy.md"));
      const usage = policy.slice(policy.indexOf("## Information usage"));

      for (const line of POLICY) assert.ok(usage.includes(line), line);
    });

  it("shows under the code box, hidden until a group is on the order",
    async () => {
      const cart = await read("layouts/partials/order/cart.html");
      const note = cart.match(/<p [^>]*data-group-note[^>]*>([^<]*)<\/p>/);

      assert.ok(note, "the cart has the group note");
      assert.match(note[0], /\bhidden\b/);
      assert.equal(note[1], NOTE);
    });
});
