// Criteria tests for #876, phase 2 of the split of staging/library.js
// (docs/refactors/staging-library.md, "Phase 2: parts and tokens"),
// held out of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/staging-library-parts.criteria.mjs \
//     test/staging-library-parts.test.mjs
//
// The eight criteria are of the new-module kind: they fail on `next`,
// where staging/library/parts.mjs does not exist, and pass once the
// phase draws it out. Each `it` is named for its box on the issue.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). A part is { text } or { token }, as the
// server's emails carry them (current.parts, current.rewrite).
//
//   ANCHOR                  the caret's anchor around a token, U+200B
//   partsOf(el)             el's content back as parts. el is read
//                           only through childNodes, nodeType,
//                           nodeName, data and dataset (design,
//                           section 2), so the nodes here are plain
//                           objects: text { nodeType: 3, data },
//                           element { nodeType: 1, nodeName,
//                           dataset, childNodes }, a token being an
//                           element with dataset.token.
//   tokensOf(parts)         -> the tokens' values, in order
//   leftOut(original, rewrite)
//                           each a list of parts (the subject's and
//                           the text's together, as noteDropped
//                           joins them today) -> the values the
//                           original has and the rewrite lacks, once
//                           each, in the original's order (today's)
//   oneLine(parts)          the subject as saved: each text part's
//                           newline, with the space around it, one
//                           space; token parts as they were
//   rewriteParts({ subject, text })
//                           the rewrite view's parts
//
// The test of purity comes from the design's module table (section
// 2: parts.mjs is listed as pure), not from a box. library/tokens.js
// (token, fill, outOfToken) is dumb and has no (test) box: it needs
// a document, which the unit tests do not have.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANCHOR, leftOut, oneLine, partsOf, rewriteParts, tokensOf,
} from "../assets/scripts/staging/library/parts.mjs";
import { assertPure } from "./pure-module.mjs";

const text = (data) => ({ nodeType: 3, nodeName: "#text", data });

const el = (nodeName, childNodes = [], dataset = {}) => ({
  nodeType: 1, nodeName, dataset, childNodes,
});

// A token as fill() draws it: a span holding its value.
const tok = (value) => el("SPAN", [text(value)], { token: value });

// The editor field itself, whose children partsOf reads.
const field = (...childNodes) => el("DIV", childNodes);

describe("staging library parts (#876)", () => {
  it("partsOf joins neighboring text into one part and keeps each "
    + "token as its own", () => {
    assert.deepEqual(partsOf(field(
      text("Hello "), text("there, "), tok("Ada"), tok("Lovelace"),
      text("."), text(" Thanks"),
    )), [
      { text: "Hello there, " },
      { token: "Ada" },
      { token: "Lovelace" },
      { text: ". Thanks" },
    ]);
  });

  it("It drops the anchors around tokens", () => {
    assert.equal(ANCHOR, "​");
    assert.deepEqual(partsOf(field(
      text(`Order ${ANCHOR}`), tok("#1042"), text(`${ANCHOR} is ready`),
    )), [
      { text: "Order " },
      { token: "#1042" },
      { text: " is ready" },
    ]);
  });

  it("A BR is a newline, and a DIV or P after the first part starts a "
    + "new line", () => {
    assert.deepEqual(partsOf(field(
      text("one"), el("BR"), text("two"),
    )), [{ text: "one\ntwo" }]);
    assert.deepEqual(partsOf(field(
      el("DIV", [text("one")]), el("DIV", [text("two")]),
      el("P", [text("three")]),
    )), [{ text: "one\ntwo\nthree" }], "the first DIV starts no line");
    assert.deepEqual(partsOf(field(
      tok("Ada"), el("DIV", [text("Thanks")]),
    )), [{ token: "Ada" }, { text: "\nThanks" }],
    "a token is a first part too");
  });

  it("It leaves out a text part that ends up empty", () => {
    assert.deepEqual(partsOf(field(
      text(ANCHOR), tok("Ada"), text(ANCHOR + ANCHOR), tok("#1042"),
      text(ANCHOR), text(""),
    )), [{ token: "Ada" }, { token: "#1042" }]);
    assert.deepEqual(partsOf(field(text(""), text(ANCHOR))), []);
  });

  it("tokensOf lists the tokens in order", () => {
    assert.deepEqual(tokensOf([
      { text: "Hi " }, { token: "Ada" }, { text: ", order " },
      { token: "#1042" }, { text: " on " }, { token: "Friday" },
      { token: "Ada" },
    ]), ["Ada", "#1042", "Friday", "Ada"]);
    assert.deepEqual(tokensOf([{ text: "No tokens" }]), []);
  });

  it("leftOut lists each token the original has and the rewrite "
    + "lacks, once", () => {
    const original = [
      { text: "Hi " }, { token: "Ada" }, { text: ", order " },
      { token: "#1042" }, { text: " is ready " }, { token: "Friday" },
      { text: ". Thanks, " }, { token: "Ada" },
    ];
    const rewrite = [{ text: "Ready " }, { token: "Friday" }];

    assert.deepEqual(leftOut(original, rewrite), ["Ada", "#1042"]);
    assert.deepEqual(leftOut(original, original), []);
    assert.deepEqual(leftOut([{ text: "Hi" }], rewrite), [],
      "a token only the rewrite has is not left out");
  });

  it("oneLine turns a newline in the subject, with the space around "
    + "it, into one space, and leaves tokens alone", () => {
    assert.deepEqual(oneLine([
      { text: "Your order \n\t is ready" }, { token: "#1042" },
      { text: "\nfor " }, { token: "Friday" },
    ]), [
      { text: "Your order is ready" }, { token: "#1042" },
      { text: " for " }, { token: "Friday" },
    ]);
    assert.deepEqual(oneLine([{ token: "line\nbreak" }]),
      [{ token: "line\nbreak" }], "a token is not a text part");
  });

  it("rewriteParts is \"Subject: \", the subject's parts, a blank line, "
    + "and the text's parts", () => {
    assert.deepEqual(rewriteParts({
      subject: [{ text: "Order " }, { token: "#1042" }],
      text: [{ text: "Hi " }, { token: "Ada" }, { text: "." }],
    }), [
      { text: "Subject: " },
      { text: "Order " }, { token: "#1042" },
      { text: "\n\n" },
      { text: "Hi " }, { token: "Ada" }, { text: "." },
    ]);
  });

  it("parts.mjs is pure (design, section 2)", () => {
    assertPure(new URL(
      "../assets/scripts/staging/library/parts.mjs", import.meta.url,
    ), {
      banned: ["document", "window", "Node", "getSelection", "location",
        "navigator", "HTMLElement", "Element", "Text"],
      door: /library\.js$/,
    });
  });
});
