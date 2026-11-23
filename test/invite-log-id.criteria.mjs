// Criteria tests for #896 (The logger's phone scrub eats ids: about 1
// invite in 60 loses its id in the log), the boxes of its "Done when"
// list, one test each, named for its box; box 3 has one test per kind
// of id the scrub could eat. Held out of npm test by its name until
// the fix lands: renamed to invite-log-id.test.mjs.
//
// The cause (lib/log.mjs, PHONE): any run of 10 or more digits, with
// spaces, dots, dashes or brackets between them, becomes "[phone]", so
// an id holding such a run loses it.
//
// Box 3's survey of the ids the logs carry, by shape:
// - Could be eaten, each tested below: order ids (NFF-YYMM- and six
//   of a base-32 alphabet with the digits 2 to 9: an all-digit tail
//   makes a run of 10 across the dash, 1 id in 4,096); idempotency
//   and attempt keys (UUIDs, hex in groups joined by dashes); Square
//   ids (order, payment, refund, customer: letters and digits);
//   PayPal ids (order, capture, refund: 17 capitals and digits).
// - Safe by shape: member ids (NFM-XXXX-XXXX, at most 8 digits);
//   times (ISO strings: at most 8 digits before the T, and the colons
//   break the rest); numbers, counts and epoch times logged as numbers
//   (the scrub reads strings only); the deploy id (added to a shipped
//   line after the scrub, by shape(), and never on the console line).
//   Customer and cart keys (a base64url hash of the address) are not
//   carried by any log line today.
//
// The keys the ids are logged under here: invite (box 1); id, key,
// squareOrderId, squarePaymentId, paypalOrderId and paypalCaptureId
// (box 3). Phones and glued digit runs go under message (a plain
// string) and detail, which are no id's keys.
//
// The seam: lines are read off console.info, as the logger writes
// them. A revoked invite is stored under `invite/<id>`, as
// lib/invites.mjs keeps it (inviteKey).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addInvite, listInvites, revokeInvite }
  from "../netlify/functions/lib/invites.mjs";
import { log, scrub } from "../netlify/functions/lib/log.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const INVITE = "inv-1234567890ab";
const now = new Date("2026-11-22T15:00:00Z");

// The console lines written while `run` runs, parsed.
const written = async (t, run) => {
  const lines = [];

  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map(String).join(" "));
    });
  }
  await run();
  for (const level of ["log", "info", "warn", "error"]) {
    console[level].mock.restore();
  }

  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
};

// An id logged in a field keeps its value, through scrub() and through
// a line on the console.
const keepsWhole = async (t, field, id) => {
  assert.equal(scrub({ [field]: id })[field], id, `scrub keeps ${id}`);

  const [line] = await written(t, () => log.info({
    event: "test.id", [field]: id,
  }));

  assert.equal(line[field], id, `the line keeps ${id}`);
};

const PHONES = ["401-555-0100", "(401) 555-0100", "+1 401 555 0100"];

// Digit runs glued to a word or a dash, in a value that is no id
// (security's review of #921). `detail` is no id's key and is not a
// field the scrub removes whole, as `note` is.
const GLUED = [
  ["call4015550100", "4015550100"], ["4015550100abc", "4015550100"],
  ["x4015550100", "4015550100"], ["home-4015550100", "4015550100"],
  ["4015550100-home", "4015550100"], ["ref401 5550100", "4015550100"],
  ["card4111111111111111", "4111111111111111"],
];

// Whether `text` still holds the digits of `run`, whatever lies
// between them.
const holds = (text, run) => text.replace(/\D+/g, "").includes(run);

describe("#896 ids survive the logger's phone scrub", () => {
  it("A log line carrying an id made of 10 or more digits in a row keeps "
    + "the id whole: invite.added and invite.revoked for an invite "
    + "inv-1234567890ab name it exactly", async (t) => {
    // The invite.added line: addInvite draws its id at random, so its line is
    // written here with the fields it logs.
    const [added] = await written(t, () => log.info({
      event: "invite.added", by: "james", invite: INVITE,
      perk: "free-delivery", end: null, expires: now.toISOString(),
      square: false, before: null, after: "open",
    }));

    assert.equal(added.invite, INVITE, "invite.added names it");

    // The invite.revoked line: a real invite stored again under the fixed id.
    const stores = testStores();
    const made = await addInvite(stores, "free-delivery", {
      by: "james", now,
    });
    const [record] = (await listInvites(stores, { now }))
      .filter((i) => i.id === made.id);

    await stores.invites.set(`invite/${INVITE}`, {
      ...record, id: INVITE, state: undefined,
    });

    const lines = await written(t, () => revokeInvite(stores, INVITE, {
      by: "james", now,
    }));
    const revoked = lines.find((l) => l.event === "invite.revoked");

    assert.ok(revoked, "invite.revoked is logged");
    assert.equal(revoked.invite, INVITE, "invite.revoked names it");
  });

  it("A phone number in a logged value is still scrubbed: 401-555-0100, "
    + "(401) 555-0100, +1 401 555 0100, alone and inside a sentence",
  async (t) => {
    for (const phone of PHONES) {
      for (const value of [phone, `Call ${phone} after noon.`]) {
        const [line] = await written(t, () => log.info({
          event: "test.phone", message: value,
        }));

        assert.match(line.message, /\[phone\]/, `scrubbed: ${value}`);
        assert.doesNotMatch(line.message, /555/, `none left: ${value}`);
        assert.doesNotMatch(scrub({ detail: value }).detail, /555/,
          `scrub() too: ${value}`);
      }
    }
  });

  it("Outside an id field, a run of 10 or more digits is scrubbed "
    + "whatever it is glued to: call4015550100, 4015550100abc, "
    + "x4015550100, home-4015550100, 4015550100-home, ref401 5550100, "
    + "card4111111111111111", async (t) => {
    for (const [value, run] of GLUED) {
      const [plain] = await written(t, () => log.info(value));
      const [keyed] = await written(t, () => log.info({
        event: "test.glued", detail: value,
      }));

      assert.equal(holds(plain.message, run), false,
        `a plain message: ${value} -> ${plain.message}`);
      assert.equal(holds(keyed.detail, run), false,
        `under detail: ${value} -> ${keyed.detail}`);
    }
  });

  it("Every other id the logs carry is checked against the scrub: an "
    + "order id", async (t) => {
    await keepsWhole(t, "id", "NFF-2610-234567");
  });

  it("Every other id the logs carry is checked against the scrub: an "
    + "idempotency or attempt key", async (t) => {
    await keepsWhole(t, "key", "12345678-9012-4abc-8def-1234567890ab");
  });

  it("Every other id the logs carry is checked against the scrub: a "
    + "Square id", async (t) => {
    await keepsWhole(t, "squareOrderId", "CAISEM1234567890aBcDeFgHiJk");
    await keepsWhole(t, "squarePaymentId", "bP9m1234567890GjjGNaNO5ZDVy");
  });

  it("Every other id the logs carry is checked against the scrub: a "
    + "PayPal id", async (t) => {
    await keepsWhole(t, "paypalOrderId", "5O1234567890TN36T");
    await keepsWhole(t, "paypalCaptureId", "3C67936612345678F");
  });
});
