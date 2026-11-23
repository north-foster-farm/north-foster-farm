// Criteria tests for #877, phase 3 of the split of staging/library.js
// (docs/refactors/staging-library.md, "Phase 3: the reader"), held out
// of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/staging-reader.criteria.mjs test/staging-reader.test.mjs
//
// All seven boxes marked (test) are of the new-module kind: they fail
// on `next`, where staging/library/review.mjs and state.mjs do not
// exist, and pass once the phase draws them out. The eighth test holds
// both modules pure, from the design's module table (section 2 lists
// them as pure), not from a box.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that both modules stay pure; the call shape may be adapted, the
// expected values may not). Paths, links and markup are today's, byte
// for byte.
//
//   review.mjs
//     viewFor(email, view)   -> the view to draw: "html", "text" or
//                               "rewrite"
//     emailPath(id, view)    -> "/api/staging/emails/<id>", with
//                               "?format=text" for the text view
//     linkTo(origin, id)     -> "<origin>/#email=<id>"; the origin is
//                               an argument, since a pure module may not
//                               read `location`
//     framed(html)           -> the email's page with
//                               <base target="_blank"> first in its head
//     hashTarget(hash)       -> { id } to open the email with that id,
//                               { id: null } to open the shelf, null to
//                               open nothing (so `open(target.id)` is
//                               today's `open(id)` and `open()`)
//
//   state.mjs, the one record: { emails, sent, current, view, approval,
//   editing }, each a new record, the one given left as it was
//     opened(state, id)      -> current is the email with that id, or
//                               null; view is "rewrite" for a rewritten
//                               email and as it was otherwise
//     saved(state, email)    -> the email with email.id replaced in the
//                               list, and as current when it is current
//
// An email "with a rewrite" is one whose approval is "rewritten", as
// lib/review.mjs gives it, carrying a `rewrite`; the fixtures below give
// both or neither, so either reading passes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  emailPath, framed, hashTarget, linkTo, viewFor,
} from "../assets/scripts/staging/library/review.mjs";
import { opened, saved } from "../assets/scripts/staging/library/state.mjs";
import { assertPure } from "./pure-module.mjs";

const LIBRARY = "../assets/scripts/staging/library/";

const parts = { subject: [{ text: "Your order" }], text: [{ text: "Hi" }] };
const toApprove = {
  id: "order-placed", name: "Order placed", approval: "to approve",
  version: "v1", parts,
};
const rewritten = {
  id: "pickup-reminder", name: "Pick-up reminder", approval: "rewritten",
  version: "v2", parts,
  rewrite: { at: "2026-11-20T15:00:00Z", subject: [{ text: "Soon" }],
    text: [{ text: "See you" }] },
};
const approved = {
  id: "farm-news", name: "Farm news", approval: "approved",
  approvedBy: "james", version: "v3", parts,
};

const record = (over = {}) => ({
  emails: [toApprove, rewritten, approved], sent: [], current: null,
  view: "html", approval: "", editing: false, ...over,
});

// Box 1 of #877.
describe("viewFor", () => {
  it("keeps the chosen view, and falls back to HTML when the rewrite "
    + "view is chosen for an email with no rewrite", () => {
    for (const view of ["html", "text"]) {
      assert.equal(viewFor(toApprove, view), view, `${view}, to approve`);
      assert.equal(viewFor(rewritten, view), view, `${view}, rewritten`);
    }
    assert.equal(viewFor(rewritten, "rewrite"), "rewrite");
    assert.equal(viewFor(toApprove, "rewrite"), "html");
    assert.equal(viewFor(approved, "rewrite"), "html");
  });
});

// Box 2 of #877.
describe("emailPath", () => {
  it("is the email's path, with ?format=text for the text view, the id "
    + "encoded", () => {
    assert.equal(emailPath("order-placed", "html"),
      "/api/staging/emails/order-placed");
    assert.equal(emailPath("order-placed", "text"),
      "/api/staging/emails/order-placed?format=text");
    assert.equal(emailPath("a b/c?d#e", "html"),
      "/api/staging/emails/a%20b%2Fc%3Fd%23e");
    assert.equal(emailPath("a b/c?d#e", "text"),
      "/api/staging/emails/a%20b%2Fc%3Fd%23e?format=text");
  });
});

// Box 3 of #877.
describe("linkTo", () => {
  it("is the site's origin and /#email= with the id encoded", () => {
    const origin = "https://staging.example";

    assert.equal(linkTo(origin, "order-placed"),
      `${origin}/#email=order-placed`);
    assert.equal(linkTo(origin, "a b/c&d"), `${origin}/#email=a%20b%2Fc%26d`);
  });
});

// Box 4 of #877.
describe("framed", () => {
  it("adds a base target of a new tab to the email's head", () => {
    const page = "<!doctype html><html><head><title>Hi</title></head>"
      + "<body><a href=\"https://example.com/\">Link</a></body></html>";

    assert.equal(framed(page), "<!doctype html><html><head>"
      + "<base target=\"_blank\"><title>Hi</title></head>"
      + "<body><a href=\"https://example.com/\">Link</a></body></html>");
  });
});

// Box 5 of #877.
describe("hashTarget", () => {
  it("opens an email for #email=<id>, the shelf for #emails, and "
    + "nothing for any other hash", () => {
    assert.deepEqual(hashTarget("#email=order-placed"),
      { id: "order-placed" });
    assert.deepEqual(hashTarget("#email=a%20b%2Fc"), { id: "a b/c" },
      "the id is decoded");
    assert.deepEqual(hashTarget("#emails"), { id: null });
    for (const hash of ["", "#", "#email", "#email=", "#emailsx", "#top",
      "#cart", "emails", "#Emails"]) {
      assert.equal(hashTarget(hash), null, `nothing for "${hash}"`);
    }
  });
});

// Box 6 of #877.
describe("opened", () => {
  it("sets the current email by id, or none for an id the list lacks, "
    + "and chooses the rewrite view for a rewritten email", () => {
    const text = record({ view: "text" });

    assert.equal(opened(text, "order-placed").current, toApprove);
    assert.equal(opened(text, "order-placed").view, "text",
      "the view stays for an email that is not rewritten");
    assert.equal(opened(text, "farm-news").current, approved);
    assert.equal(opened(text, "farm-news").view, "text");

    assert.equal(opened(text, "pickup-reminder").current, rewritten);
    assert.equal(opened(text, "pickup-reminder").view, "rewrite");

    const was = record({ current: toApprove });

    assert.equal(opened(was, "no-such-email").current, null);
    assert.deepEqual(opened(was, "no-such-email").emails, was.emails);
  });
});

// Box 7 of #877.
describe("saved", () => {
  it("replaces the email with the same id in the list and as the "
    + "current one", () => {
    const answer = { ...toApprove, approval: "approved",
      approvedBy: "james", approvedAt: "2026-11-22T14:00:00Z" };
    const open = saved(record({ current: toApprove }), answer);

    assert.deepEqual(open.emails, [answer, rewritten, approved],
      "in its place, the others as they were");
    assert.equal(open.current, answer);

    const other = saved(record({ current: rewritten }), answer);

    assert.deepEqual(other.emails, [answer, rewritten, approved]);
    assert.equal(other.current, rewritten,
      "another open email stays open");
    assert.equal(saved(record(), answer).current, null,
      "none open stays none");
  });
});

// From the design's module table, not a box: both modules are pure.
describe("review.mjs and state.mjs", () => {
  it("are pure, and leave the record they are given as it was", () => {
    const banned = [
      "document", "window", "location", "history", "navigator", "Node",
      "getSelection", "fetch", "setTimeout", "confirm", "prompt",
      "localStorage", "sessionStorage", "Element", "HTMLElement",
    ];

    for (const name of ["review.mjs", "state.mjs"]) {
      assertPure(new URL(LIBRARY + name, import.meta.url), { banned });
    }

    const was = record({ view: "text", current: toApprove });
    const copy = structuredClone(was);

    opened(was, "pickup-reminder");
    saved(was, { ...toApprove, approval: "approved" });
    assert.deepEqual(was, copy);
  });
});
