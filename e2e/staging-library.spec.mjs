// Phase 0 of the split of assets/scripts/staging/library.js (#874,
// docs/refactors/staging-library.md): the email library as James uses
// it, pinned before any of it moves. One test per box of the issue's
// "Done when" marked (test), each named for its box. They pass against
// the library as it is today; a phase that turns one red has changed
// what James sees.
//
// On the staging branch deploy only, with a gate session's nff_gate
// cookie value in E2E_GATE_SESSION, as staging-toolbar's packing slips
// and reset tests are; skipped otherwise. Boxes 6 to 8 need a session
// that may review, James's alone: they skip unless /api/staging/info
// lists "review", and are then left to the unit tests of phases 2 and
// 4. They put back what they change (the approval withdrawn, the
// rewrite dropped), and each project takes its own emails.

import {
  asTokens, deleteToken, drop, els, emailPath, getText, groupsOf, held,
  holding, idsOf, library, lone, mayReview, mine, openEmail, openShelf,
  pick, saveRewrite, shownGroups, shownIds, signIn, waiting,
} from "./support/library.mjs";
import { expect, test } from "./support/order.mjs";

// The shelf's groups: each audience and its heading, in the order shown.
const GROUPS = [
  ["customer", "To the customer"],
  ["farm", "To the farm"],
  ["list", "Farm news"],
];
// The heading of the sent mail's group, James's alone, left out of box 1.
const SENT = "Sent, every session";
const PINNED = " Pinned by the e2e suite.";
const DROP = "Drop your rewrite and keep the current wording?";
const REWRITTEN = "rewritten, to apply";

// Puts back what a review test changed, and fails the test if it could
// not. Soft, so a failure before it stays the one reported.
const putBack = async (page, path) => {
  const res = await page.request.delete(path);

  expect.soft(res.ok(), `DELETE ${path}: ${res.status()}`).toBe(true);
};

test.describe("staging email library (#874)", () => {
  test.use({ hideToolbar: false });
  test.beforeEach(({ context, baseURL }) => signIn(context, baseURL));

  test("1. #emails on any page opens the library with the search "
    + "focused and the emails listed by audience, each group with its "
    + "count", async ({ page }) => {
    for (const path of ["/", "/about/", "/order/"]) {
      const ui = await openShelf(page, path);

      await expect(ui.box).toBeVisible();
      await expect(ui.search).toBeFocused();
      expect(await shownGroups(page, SENT), path)
        .toEqual(groupsOf(await library(page), GROUPS));
    }
  });

  test("2. Words typed in the search narrow the list to emails that "
    + "hold every word, in the name, subject, text or tags",
  async ({ page }) => {
    const ui = await openShelf(page);
    const emails = await library(page);
    const both = [pick(emails, "name").word, pick(emails, "tags").word];

    for (const field of ["name", "subject", "text", "tags"]) {
      const { email, word } = pick(emails, field);

      await ui.search.fill(word);
      await expect.poll(() => shownIds(ui), `${field}: ${word}`)
        .toEqual(holding(emails, [word]));
      expect(await shownIds(ui)).toContain(email.id);
    }
    await ui.search.fill(both.join(" "));
    await expect.poll(() => shownIds(ui)).toEqual(holding(emails, both));
    await ui.search.fill("zzqxnothingholdsthis");
    await expect(ui.rows).toHaveCount(0);
    await expect(ui.empty).toBeVisible();
  });

  test("3. A tag pressed becomes the search. An approval filter "
    + "narrows the list to that approval", async ({ page }) => {
    const ui = await openShelf(page);
    const emails = await library(page);
    const { email, word: tag } = pick(emails, "tags");

    await ui.row(email.id).locator(`[data-tag="${tag}"]`).click();
    await expect(ui.search).toHaveValue(tag);
    await expect.poll(() => shownIds(ui)).toEqual(holding(emails, [tag]));
    await ui.search.fill("");
    for (const approval of ["to approve", "approved", "rewritten"]) {
      await ui.filter(approval).click();
      await expect(ui.filter(approval)).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => shownIds(ui), approval)
        .toEqual(idsOf(emails, (e) => e.approval === approval));
    }
  });

  test("4. A row opens its email, sets #email=<id>, and shows the HTML. "
    + "Text shows the plain text", async ({ page }) => {
    const ui = await openShelf(page);
    const email = (await library(page))
      .find((e) => !e.error && e.approval !== "rewritten");
    const html = await getText(page, emailPath(email));
    const text = await getText(page, `${emailPath(email)}?format=text`);
    const body = html.search(/<body/i);

    expect(body, "the email's HTML has a <body").toBeGreaterThanOrEqual(0);

    await ui.row(email.id).click();
    await expect(ui.name).toHaveText(email.name);
    expect(await page.evaluate(() => location.hash))
      .toBe(`#email=${encodeURIComponent(email.id)}`);
    await expect(ui.frame).toBeVisible();
    await expect.poll(() => ui.frame.getAttribute("srcdoc"))
      .toContain(html.slice(body));
    await ui.view("text").click();
    await expect(ui.text).toBeVisible();
    await expect(ui.frame).toBeHidden();
    await expect.poll(() => ui.text.evaluate((el) => el.textContent))
      .toBe(text);
  });

  test("5. Escape closes the library, clears the hash, and puts the "
    + "focus back where it was", async ({ page }) => {
    await page.goto("/about/");
    await expect(page.locator("#staging")).toBeVisible();

    const ui = els(page);
    const opener = page.locator("main a[href]:visible").first();

    await opener.focus();
    await page.evaluate(() => { location.hash = "emails"; });
    await expect(ui.search).toBeFocused();
    await ui.rows.first().click();
    await expect(ui.reader).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ui.box).toBeHidden();
    expect(await page.evaluate(() => location.hash)).toBe("");
    await expect(opener).toBeFocused();
  });

  test.describe("review, for a session that may review", () => {
    test.beforeEach(({ page }) => mayReview(page));

    test("6. Approve marks the email approved everywhere it shows, with "
      + "no reload", async ({ page }) => {
      const email = mine(await library(page), 0);
      const ui = await openShelf(page);
      const before = await waiting(ui);

      await page.evaluate(() => { window.pinned = true; });
      await ui.row(email.id).click();
      try {
        await ui.approve.click();
        await expect(ui.badge).toHaveText("approved");
        await expect(ui.row(email.id).locator(".staging-badge"))
          .toHaveAttribute("data-approval", "approved");
        await expect(ui.count).toContainText(`To approve: ${before - 1}`);
        await expect(ui.summary).toContainText(`${before - 1} to approve`);
        await expect(ui.approve).toBeHidden();
        expect(await page.evaluate(() => window.pinned)).toBe(true);
      } finally {
        await putBack(page, `${emailPath(email)}/approval`);
      }
    });

    test("7. Rewrite opens the subject and text with the sample values "
      + "as tokens. Deleting one names it under \"Left out\"",
    async ({ page }) => {
      const email = mine(await library(page), 1, lone);
      const ui = await openEmail(page, email);

      await ui.rewrite.click();
      await expect(ui.editor).toBeVisible();
      expect(await held(ui.subject)).toEqual(asTokens(email.parts.subject));
      expect(await held(ui.body)).toEqual(asTokens(email.parts.text));
      await expect(ui.dropped).toBeHidden();
      await deleteToken(page, ui, lone(email));
      await expect(ui.dropped).toBeVisible();
      await expect(ui.dropped).toHaveText(`Left out: ${lone(email)}`);
      await page.locator("[data-staging-edit-cancel]").click();
      await expect(ui.editor).toBeHidden();
    });

    test("8. Saving shows the rewrite, and Drop, once confirmed, brings "
      + "the current wording back", async ({ page }) => {
      const email = mine(await library(page), 2);
      const ui = await openEmail(page, email);

      try {
        await saveRewrite(page, ui, PINNED);
        await expect(ui.editor).toBeHidden();
        await expect(ui.rewritten).toContainText(PINNED.trim());
        await expect(ui.view("rewrite"))
          .toHaveAttribute("aria-pressed", "true");
        await expect(ui.badge).toHaveText(REWRITTEN);
        expect(await drop(page, ui, false)).toBe(DROP);
        await expect(ui.badge).toHaveText(REWRITTEN);
        expect(await drop(page, ui, true)).toBe(DROP);
        await expect(ui.badge).toHaveText("to approve");
        await expect(ui.rewritten).toBeHidden();
        await expect(ui.view("rewrite")).toBeHidden();
        await expect(ui.frame).toBeVisible();
      } finally {
        await putBack(page, `${emailPath(email)}/rewrite`);
      }
    });
  });
});
