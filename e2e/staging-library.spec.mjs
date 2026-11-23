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

// #877, phase 3 of the split (the reader moves to library/reader.js):
// six behaviors of the open email that nothing pinned, pinned before
// the move, one test per criterion, each named for it (criterion 6 is
// two, so the half that can run never hides behind a skip). They pass
// against the library as it is today, on staging's real emails: no
// answer is made up. Criterion 3's "not found" is the API's own 404,
// fetched for an id that does not exist; criterion 4 holds back a real
// answer, unchanged.
const NO_SUCH_EMAIL = "/api/staging/emails/zz-no-such-email";
const COPY = "[data-staging-copy-link]";
const NOT_REWRITTEN = (e) => e.approval !== "rewritten";

// Two emails of the library, for a test that opens one then another.
const twoOf = (emails) => {
  expect(emails.length, "staging's library has two emails").toBeGreaterThan(1);

  return [emails[0], emails[1]];
};

// Makes the clipboard answer `works`: the page's clipboard is
// replaced, as `drop` (support/library.mjs) replaces confirm, since
// a headless browser may refuse the real one; prompt is recorded.
const clipboard = (page, works) => page.evaluate((ok) => {
  window.e2ePrompted = undefined;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => (ok ? Promise.resolve()
      : Promise.reject(new Error("refused"))) },
  });
  window.prompt = (question, value) => {
    window.e2ePrompted = [question, value];

    return null;
  };
}, works);

test.describe("staging email library, the reader (#877)", () => {
  test.use({ hideToolbar: false });
  test.beforeEach(({ context, baseURL }) => signIn(context, baseURL));

  test("Back hides the reader, sets the hash to #emails and focuses the "
    + "search", async ({ page }) => {
    const [email] = await library(page);
    const ui = await openEmail(page, email);

    await expect(ui.reader).toBeVisible();
    await page.locator("[data-staging-reader-back]").click();
    await expect(ui.reader).toBeHidden();
    expect(new URL(page.url()).hash).toBe("#emails");
    await expect(ui.search).toBeFocused();
  });

  test("Copy link shows \"Copied\" and resets after 1.2 s, with the "
    + "browser prompt as the fallback when the clipboard is refused",
  async ({ page, baseURL }) => {
    const [email] = await library(page);

    await openEmail(page, email);

    const button = page.locator(COPY);
    const link = `${new URL(baseURL).origin}/#email=${
      encodeURIComponent(email.id)}`;

    await clipboard(page, true);
    await button.click();
    await expect(button).toHaveText("Copied");
    await page.waitForTimeout(800);
    await expect(button, "still Copied before 1.2 s").toHaveText("Copied");
    await expect(button).toHaveText("Copy link", { timeout: 2_000 });
    expect(await page.evaluate(() => window.e2ePrompted)).toBeUndefined();

    await clipboard(page, false);
    await button.click();
    expect(await page.evaluate(() => window.e2ePrompted))
      .toEqual(["The link to this email:", link]);
    await expect(button).not.toHaveText("Copied");
  });

  test("The text view shows the email's text, and an email that is not "
    + "found shows \"Not found.\" in the text view and in the frame",
  async ({ page }) => {
    const [shown, missing] = twoOf(await library(page));
    let ui = await openEmail(page, shown);

    await ui.view("text").click();
    await expect(ui.text)
      .toHaveText(await getText(page, `${emailPath(shown)}?format=text`));

    const gone = await page.request.get(NO_SUCH_EMAIL);

    expect(gone.ok(), `${NO_SUCH_EMAIL} is not found`).toBe(false);
    await page.route(`**${emailPath(missing)}*`, async (route) => route
      .fulfill({ response: await route.fetch({ url: gone.url() }) }));
    ui = await openEmail(page, missing);
    await ui.view("html").click();
    await expect(ui.frame).toHaveAttribute("srcdoc", "<p>Not found.</p>");
    await ui.view("text").click();
    await expect(ui.text).toHaveText("Not found.");
  });

  test("A stale answer is dropped: when a second email is opened before "
    + "the first answers, the first's late answer does not replace the "
    + "second", async ({ page }) => {
    const [first, second] = twoOf(await library(page)
      .then((all) => all.filter(NOT_REWRITTEN)));
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const late = page.waitForResponse((r) => r.url()
      .endsWith(emailPath(first)));

    await page.route(`**${emailPath(first)}`, async (route) => {
      const answer = await route.fetch();

      await held;
      await route.fulfill({ response: answer });
    });

    const ui = await openEmail(page, first);

    await page.evaluate((id) => { location.hash = `#email=${id}`; },
      encodeURIComponent(second.id));
    await expect(ui.name).toHaveText(second.name);
    await expect(ui.frame).toHaveAttribute("srcdoc", /./);

    const secondDoc = await ui.frame.getAttribute("srcdoc");

    release();
    await late;
    await page.waitForTimeout(500);
    await expect(ui.name).toHaveText(second.name);
    expect(await ui.frame.getAttribute("srcdoc"),
      "the first's late answer did not replace the second").toBe(secondDoc);
  });

  test("Attachments show as links that go to a new tab, and the list is "
    + "hidden when there are none", async ({ page }) => {
    const emails = await library(page);
    const withFiles = emails.find((e) => (e.attachments || []).length);
    const without = emails.find((e) => !(e.attachments || []).length);

    expect(withFiles, "an email on staging with attachments").toBeTruthy();
    expect(without, "an email on staging without attachments").toBeTruthy();

    await openEmail(page, withFiles);

    const holder = page.locator("[data-staging-reader-attachments]");
    const links = page.locator("[data-staging-reader-files] a");

    await expect(holder).toBeVisible();
    await expect(links)
      .toHaveText(withFiles.attachments.map((f) => f.filename));
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute("target", "_blank");
    }

    const tab = page.waitForEvent("popup");

    await links.first().click();
    await (await tab).close();

    await openEmail(page, without);
    await expect(holder).toBeHidden();
  });

  test("An email that has a rewrite opens at its rewrite, and the Rewrite "
    + "button is hidden for one that has none (one with a rewrite)",
  async ({ page }) => {
    const rewritten = (await library(page))
      .find((e) => e.approval === "rewritten");

    test.skip(!rewritten, "NOT RUN: no email on staging has approval "
      + "\"rewritten\"; only a review session can make one");

    const ui = await openEmail(page, rewritten);

    await expect(ui.view("rewrite")).toBeVisible();
    await expect(ui.view("rewrite")).toHaveAttribute("aria-pressed", "true");
    await expect(ui.rewritten).toBeVisible();
    await expect(ui.frame).toBeHidden();
  });

  test("An email that has a rewrite opens at its rewrite, and the Rewrite "
    + "button is hidden for one that has none (one without)",
  async ({ page }) => {
    const plain = (await library(page)).find(NOT_REWRITTEN);

    expect(plain, "an email on staging without a rewrite").toBeTruthy();

    const ui = await openEmail(page, plain);

    await expect(ui.view("rewrite")).toBeHidden();
    await expect(ui.frame).toBeVisible();
  });
});
