// Criteria tests for #878, phase 4 of the split of staging/library.js
// (docs/refactors/staging-library.md, "Phase 4: review and the
// editor"), one per (test) box of the issue, written by the test agent
// before the move. They fail on `next`, where staging/library/
// review.mjs does not exist, and pass once the phase draws the review
// bar's decisions into it.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice, plain data so
// that the module stays pure; the call shape may be adapted, the
// expected values may not). The words are today's, byte for byte,
// from drawReview in library.js.
//
//   buttonsFor(email, { canReview, editing })
//     email      the email as GET /api/staging/emails gives it:
//                approval ("to approve", "approved", "rewritten"),
//                approvedBy ("code" or "staging"), error when it
//                failed to build
//     canReview  whether this session may review (a boolean, asked
//                by the caller at the moment of drawing)
//     editing    whether the editor is open
//     ->  { bar, approve, rewrite, withdraw, drop, rewriteLabel }
//         each of the five true when it shows; drop is the button
//         the toolbar marks data-staging-revert
//
//   statusLine(email)       -> the review status's text, "" for none
//   reviewPath(id, kind)    -> the path for kind "approval" or
//                              "rewrite"
//
// The days in statusLine are compared with today's format
// (toLocaleString in the runner's locale, as library.js's `day`).
// The test of purity comes from the design's module table (section
// 2: review.mjs is listed as pure), not from a box.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertPure } from "./pure-module.mjs";

const url = new URL("../assets/scripts/staging/library/review.mjs",
  import.meta.url);
// Imported in each test, so that each criterion fails on its own
// while the module is missing.
const review = () => import(url.href);

const BUTTONS = ["approve", "rewrite", "withdraw", "drop"];

const toApprove = { id: "welcome", approval: "to approve", version: "v1" };
const byJames = {
  id: "welcome", approval: "approved", approvedBy: "staging",
  approvedAt: "2026-11-20T15:04:00.000Z", version: "v1",
};
const byCode = {
  id: "welcome", approval: "approved", approvedBy: "code", version: "v1",
};
const rewritten = {
  id: "welcome", approval: "rewritten", version: "v1",
  rewrite: {
    at: "2026-11-21T18:30:00.000Z", version: "v1",
    subject: [{ text: "Hello" }], text: [{ text: "Thanks" }],
  },
};
const failed = { ...toApprove, error: "Cannot read properties of null" };

const day = (iso) => new Date(iso).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

const shown = (b) => BUTTONS.filter((name) => b[name]);

describe("staging/library/review.mjs: the review bar (#878)", () => {
  it("buttonsFor hides the bar from a session that may not review, for "
    + "an email the code approved, and for one that failed to build",
  async () => {
    const { buttonsFor } = await review();
    const as = (email, canReview = true) =>
      buttonsFor(email, { canReview, editing: false }).bar;

    for (const email of [toApprove, byJames, rewritten]) {
      assert.equal(as(email, false), false,
        `${email.approval}: no bar without review`);
      assert.equal(as(email), true, `${email.approval}: the bar shows`);
    }
    assert.equal(as(byCode), false, "approved in the code");
    assert.equal(as(failed), false, "failed to build");
  });

  it("It offers Approve only for an email to approve, Rewrite for one to "
    + "approve or rewritten, Withdraw for one James approved, and Drop "
    + "for a rewritten one", async () => {
    const { buttonsFor } = await review();
    const offered = (email) =>
      shown(buttonsFor(email, { canReview: true, editing: false }));

    assert.deepEqual(offered(toApprove), ["approve", "rewrite"]);
    assert.deepEqual(offered(byJames), ["withdraw"]);
    assert.deepEqual(offered(rewritten), ["rewrite", "drop"]);
    assert.deepEqual(offered(byCode).filter((n) => n === "withdraw"), [],
      "no Withdraw for what the code approved");
  });

  it("It hides all four while the editor is open", async () => {
    const { buttonsFor } = await review();

    for (const email of [toApprove, byJames, rewritten]) {
      const b = buttonsFor(email, { canReview: true, editing: true });

      assert.deepEqual(shown(b), [], email.approval);
    }
  });

  it("Rewrite reads \"Edit the rewrite\" for a rewritten email",
    async () => {
      const { buttonsFor } = await review();
      const label = (email) =>
        buttonsFor(email, { canReview: true, editing: false }).rewriteLabel;

      assert.equal(label(rewritten), "Edit the rewrite");
      assert.equal(label(toApprove), "Rewrite");
    });

  it("statusLine says when James approved or rewrote it, and nothing "
    + "otherwise", async () => {
    const { statusLine } = await review();

    assert.equal(statusLine(byJames),
      `You approved it ${day(byJames.approvedAt)}.`);
    assert.equal(statusLine(rewritten),
      `You rewrote it ${day(rewritten.rewrite.at)}. `
      + "It goes into the code next.");
    assert.equal(statusLine(toApprove), "");
    assert.equal(statusLine(byCode), "", "approved in the code");
    assert.equal(statusLine({ ...rewritten, rewrite: undefined }), "",
      "rewritten with no rewrite at hand");
  });

  it("reviewPath is the email's path and the kind, the id encoded",
    async () => {
      const { reviewPath } = await review();

      assert.equal(reviewPath("welcome", "approval"),
        "/api/staging/emails/welcome/approval");
      assert.equal(reviewPath("welcome", "rewrite"),
        "/api/staging/emails/welcome/rewrite");
      assert.equal(reviewPath("a b/c?d#e", "approval"),
        "/api/staging/emails/a%20b%2Fc%3Fd%23e/approval");
    });

  it("review.mjs is pure (the design's module table)", () => {
    assertPure(url, {
      banned: ["document", "window", "navigator", "querySelector",
        "addEventListener", "localStorage", "confirm", "prompt", "fetch"],
    });
  });
});
