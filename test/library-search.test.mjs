// Criteria tests for #875, phase 1 of the split of staging/library.js
// (docs/refactors/staging-library.md, "Phase 1: the search and the
// tally"), held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/library-search.criteria.mjs test/library-search.test.mjs
//
// The seven criteria here are of the new-module kind: they fail on
// `next`, where staging/library/search.mjs does not exist, and pass
// once the phase draws it out of library.js.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). The words are today's, byte for byte.
//
//   wordsOf(query)                     -> the query's words
//   matches(email, words, approval)    -> boolean
//     words     wordsOf's
//     approval  the filter, "" (or left out) for none
//   sentMatches(message, words)        -> boolean
//     message   one of /api/staging/sent's: { id, at, subject, to },
//               `to` one address or a list of them
//   grouped({ emails, sent, words, approval, canSeeSent })
//     -> [{ key, title, items }], the shelf's groups in order: the
//        audiences "customer", "farm" and "list", then "sent"
//     canSeeSent  the answer of canSeeSent(), asked by the caller
//   summaryLine(emails)                -> the summary's text
//
// Two tests come from the spec's own lines, not from a box: the one
// of purity, from the design's module table (section 2: search.mjs
// is listed as pure), and the one that library.js re-exports the same
// tally ("library.js re-exports tally").

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertPure } from "./pure-module.mjs";
import { tally as rootTally } from "../assets/scripts/staging/library.js";
import {
  grouped, matches, sentMatches, summaryLine, tally, wordsOf,
} from "../assets/scripts/staging/library/search.mjs";

const SEARCH = new URL("../assets/scripts/staging/library/search.mjs",
  import.meta.url);

// One email as /api/staging/emails lists it, with nothing in it that
// the tests below search for.
const email = (over = {}) => ({
  id: "plain-id",
  name: "Plain name",
  when: "Plain when",
  subject: "Plain subject",
  text: "Plain text",
  approval: "approved",
  audience: "customer",
  tags: ["plain"],
  ...over,
});

const ids = (list) => list.map((e) => e.id);

// Box 1 of #875.
describe("wordsOf", () => {
  it("lower-cases the query and splits it on spaces, with no empty "
    + "word", () => {
    assert.deepEqual(wordsOf("Order Placed"), ["order", "placed"]);
    assert.deepEqual(wordsOf("  PICKUP   reminder  "),
      ["pickup", "reminder"]);
    assert.deepEqual(wordsOf(""), []);
    assert.deepEqual(wordsOf("   "), []);
  });
});

// Box 2 of #875.
describe("matches", () => {
  it("is true when every word is in the email's id, name, when, "
    + "subject, text, approval, approval label, audience or tags", () => {
    const fields = [
      ["id", { id: "order-placed" }, "order-placed"],
      ["name", { name: "Order Shipped" }, "shipped"],
      ["when", { when: "The night before pickup" }, "night"],
      ["subject", { subject: "Your Eggs are ready" }, "eggs"],
      ["text", { text: "Thanks for the order, Sam" }, "sam"],
      ["approval", { approval: "approved" }, "approved",
        { approval: "to approve" }],
      ["approval label", { approval: "rewritten" }, "apply"],
      ["audience", { audience: "farm" }, "farm"],
      ["tags", { tags: ["plain", "Refund"] }, "refund"],
    ];

    for (const [field, over, word, base = {}] of fields) {
      assert.equal(matches(email(over), [word]), true, field);
      assert.equal(matches(email(base), [word]), false,
        `${field}: the word is not in the email without it`);
    }

    const both = email({ name: "Order Shipped", tags: ["refund"] });

    assert.equal(matches(both, ["shipped", "refund"]), true,
      "words in two fields");
    assert.equal(matches(both, ["shipped", "missing"]), false,
      "one word missing");
    assert.equal(matches(both, []), true, "no words");
  });
});

// Box 3 of #875.
describe("matches with an approval filter", () => {
  it("is also false for any other approval", () => {
    const each = ["to approve", "approved", "rewritten"]
      .map((approval) => email({ id: approval, approval }));

    for (const filter of ["to approve", "approved", "rewritten"]) {
      assert.deepEqual(
        ids(each.filter((e) => matches(e, [], filter))), [filter], filter
      );
    }
    assert.equal(matches(email({ approval: "to approve" }), ["plain"],
      "to approve"), true, "the filter and the words both hold");
    assert.equal(matches(email({ approval: "to approve" }), ["missing"],
      "to approve"), false, "the filter holds, a word does not");
    assert.equal(matches(email(), ["plain"], ""), true, "no filter");
  });
});

// Box 4 of #875.
describe("sentMatches", () => {
  it("looks in a sent email's subject and addresses", () => {
    const one = {
      id: "m1", at: "2026-11-20T14:00:00.000Z",
      subject: "Your Order is placed", to: "sam@example.com",
    };
    const many = { ...one, to: ["sam@example.com", "Farm@example.org"] };

    assert.equal(sentMatches(one, ["order"]), true, "the subject");
    assert.equal(sentMatches(one, ["sam@example.com"]), true,
      "one address");
    assert.equal(sentMatches(many, ["farm@example.org"]), true,
      "the second of two addresses");
    assert.equal(sentMatches(many, ["placed", "sam"]), true,
      "subject and address together");
    assert.equal(sentMatches(one, ["placed", "missing"]), false,
      "one word missing");
    assert.equal(sentMatches(one, []), true, "no words");
  });
});

const SENT = [
  { id: "m1", at: "2026-11-20T14:00:00.000Z", subject: "Order placed",
    to: "sam@example.com" },
];

const library = (over = {}) => grouped({
  emails: [
    email({ id: "c1", audience: "customer", name: "Order placed" }),
    email({ id: "f1", audience: "farm", name: "New order" }),
    email({ id: "l1", audience: "list", name: "Farm news" }),
    email({ id: "c2", audience: "customer", name: "Pickup reminder" }),
  ],
  sent: SENT, words: [], approval: "", canSeeSent: true,
  ...over,
});

// Box 5 of #875.
describe("grouped", () => {
  it("gives the three audiences in order, each with its matching "
    + "emails, and leaves out an audience with none", () => {
    const all = library({ canSeeSent: false });

    assert.deepEqual(
      all.map((g) => [g.key, g.title, ids(g.items)]),
      [
        ["customer", "To the customer", ["c1", "c2"]],
        ["farm", "To the farm", ["f1"]],
        ["list", "Farm news", ["l1"]],
      ]
    );

    const orders = library({ words: ["order"], canSeeSent: false });

    assert.deepEqual(
      orders.map((g) => [g.key, ids(g.items)]),
      [["customer", ["c1"]], ["farm", ["f1"]]],
      "the list's audience has no email with the word"
    );

    const listed = library({
      emails: [email({ id: "l1", audience: "list" }),
        email({ id: "c1", audience: "customer" })],
      canSeeSent: false,
    });

    assert.deepEqual(listed.map((g) => g.key), ["customer", "list"],
      "in the shelf's order, not the list's");
  });
});

// Box 6 of #875.
describe("grouped's sent group", () => {
  it("is left out with an approval filter set, and for a session that "
    + "may not see sent mail", () => {
    const shown = library();
    const last = shown.at(-1);

    assert.deepEqual([last.key, last.title, ids(last.items)],
      ["sent", "Sent, every session", ["m1"]],
      "shown with no filter, to a session that may see it");
    assert.equal(
      library({ approval: "approved" }).some((g) => g.key === "sent"),
      false, "an approval filter"
    );
    assert.equal(
      library({ canSeeSent: false }).some((g) => g.key === "sent"),
      false, "a session that may not see sent mail"
    );
  });
});

// Box 7 of #875.
describe("summaryLine", () => {
  it("counts the emails and those to approve, and those rewritten only "
    + "when there are some", () => {
    assert.equal(summaryLine([
      email({ approval: "to approve" }),
      email({ approval: "to approve" }),
      email({ approval: "approved" }),
    ]), "3, 2 to approve");
    assert.equal(summaryLine([
      email({ approval: "to approve" }),
      email({ approval: "rewritten" }),
      email({ approval: "rewritten" }),
      email({ approval: "approved" }),
    ]), "4, 1 to approve, 2 rewritten");
    assert.equal(summaryLine([]), "0, 0 to approve");
  });
});

// From the spec: "library.js re-exports tally".
describe("tally", () => {
  it("is the one library.js exports", () => {
    assert.equal(rootTally, tally);
  });
});

// From the design's module table: search.mjs is pure.
describe("search.mjs", () => {
  it("reaches no browser global and imports only .mjs modules", () => {
    assertPure(SEARCH, {
      banned: ["document", "window", "location", "history", "navigator",
        "Node", "getSelection", "querySelector", "localStorage"],
      door: /library\.js$/,
    });
  });
});
