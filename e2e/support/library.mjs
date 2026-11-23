// The staging toolbar's email library (assets/scripts/staging/
// library.js), for staging-library.spec.mjs (#874): the session it
// needs, its elements, and what the library's own data says the shelf
// and the editor should show.

import { expect, test } from "./order.mjs";
import { PROJECTS } from "./projects.mjs";

const branch = (baseURL) => {
  const host = new URL(baseURL).hostname;

  return host.includes("--") && !host.startsWith("deploy-preview-");
};

// The gate session in E2E_GATE_SESSION, on a branch deploy; skips the
// test otherwise.
export const signIn = async (context, baseURL) => {
  test.skip(!branch(baseURL), "only on a branch deploy");
  test.skip(!process.env.E2E_GATE_SESSION, "needs a gate session");
  await context.addCookies([{
    name: "nff_gate", value: process.env.E2E_GATE_SESSION, path: "/",
    domain: new URL(baseURL).hostname, httpOnly: true, secure: true,
    sameSite: "Lax",
  }]);
};

const getJson = async (page, path) => (await page.request.get(path)).json();

export const library = async (page) =>
  (await getJson(page, "/api/staging/emails")).emails;
export const getText = async (page, path) =>
  (await page.request.get(path)).text();
export const emailPath = (e) =>
  `/api/staging/emails/${encodeURIComponent(e.id)}`;

export const mayReview = async (page) => {
  const { can = [] } = await getJson(page, "/api/staging/info");

  test.skip(!can.includes("review"),
    "needs a session that may review; left to phases 2 and 4");
};

export const els = (page) => {
  const q = (name) => page.locator(`[data-staging-${name}]`);

  return {
    box: q("library"), search: q("search"), summary: q("library-summary"),
    count: q("library-count"), rows: q("shelf").locator("a[data-id]"),
    empty: q("shelf-empty"), reader: q("reader"), frame: q("frame"),
    text: q("text"), rewritten: q("rewritten"), badge: q("reader-approval"),
    name: q("reader-name"), editor: q("editor"), subject: q("edit-subject"),
    body: q("edit-text"), dropped: q("edit-dropped"),
    approve: q("approve"), rewrite: q("rewrite"), revert: q("revert"),
    view: (v) => page.locator(`[data-staging-view="${v}"]`),
    filter: (v) => page.locator(`[data-staging-filter="${v}"]`),
    row: (id) => q("shelf").locator(`a[data-id="${id}"]`),
  };
};

const opened = async (page, url, ready) => {
  await page.goto(url);

  const ui = els(page);

  await expect(ready(ui)).not.toBeEmpty();

  return ui;
};

export const openShelf = (page, path = "/") =>
  opened(page, `${path}#emails`, (ui) => ui.summary);
export const openEmail = (page, e) =>
  opened(page, `/#email=${encodeURIComponent(e.id)}`, (ui) => ui.name);

export const shownIds = (ui) => ui.rows.evaluateAll(
  (links) => links.map((a) => a.dataset.id).sort());
export const idsOf = (emails, keep) =>
  emails.filter(keep).map((e) => e.id).sort();

const GROUPS = [
  ["customer", "To the customer"],
  ["farm", "To the farm"],
  ["list", "Farm news"],
];

// Each audience with emails, in order: its heading and its ids.
export const groupsOf = (emails) => GROUPS.map(([audience, title]) => {
  const ids = idsOf(emails, (e) => e.audience === audience);

  return [`${title} (${ids.length})`, ids];
}).filter(([, ids]) => ids.length);

// The shelf's groups as shown, the sent mail (James's alone) left out.
export const shownGroups = (page) =>
  page.locator(".staging-group").evaluateAll((groups) => groups
    .map((g) => [g.querySelector("h2").textContent,
      [...g.querySelectorAll("a[data-id]")].map((a) => a.dataset.id).sort()])
    .filter(([h]) => !h.startsWith("Sent, every session")));

// The fields the search box names: name, subject, text and tags. A
// word is chosen only when it is in none of the fields the search also
// reads (id, when, approval, audience, and "apply" from the badge
// "rewritten, to apply"), so the list predicted from the four is the
// list the library shows.
const named = (e) => [e.name, e.subject, e.text, ...(e.tags || [])]
  .join("\n").toLowerCase();
const other = (e) =>
  `${e.id} ${e.when} ${e.approval} ${e.audience} apply`.toLowerCase();

export const holding = (emails, words) =>
  idsOf(emails, (e) => words.every((w) => named(e).includes(w)));

const wordsOf = (e, field) => (field === "tags"
  ? (e.tags || []).filter((t) => /^[a-z]{4,}$/.test(t))
  : String(e[field] || "").toLowerCase().match(/[a-z]{5,}/g) || []);

// A word from one email's `field` that narrows the list. -> { email,
// word }.
export const pick = (emails, field) => {
  const fits = (w) => !emails.some((e) => other(e).includes(w))
    && holding(emails, [w]).length < emails.length;

  for (const e of emails) {
    const word = wordsOf(e, field).find(fits);

    if (word) return { email: e, word };
  }
  throw new Error(`No word in the ${field} narrows the library.`);
};

// The project's own email for review test `n`, from those `ok` keeps,
// so two projects at once never review the same one.
export const mine = (emails, n, ok = () => true) => {
  const pool = emails.filter((e) => e.approval === "to approve"
    && !e.error && !e.rewrite && ok(e));
  const slot = PROJECTS.indexOf(test.info().project.name) * 3 + n;

  test.skip(pool.length <= slot, "not enough emails to approve");

  return pool[slot];
};

const tokens = (parts) => parts
  .filter((p) => p.token !== undefined).map((p) => p.token);

// The tokens an editor field holds, each with whether it can be edited.
export const held = (el) => el.locator("[data-token]").evaluateAll(
  (spans) => spans.map((s) => [s.dataset.token, s.isContentEditable]));
export const asTokens = (parts) => tokens(parts).map((t) => [t, false]);

// A token of the text that the subject and the rest of the text lack.
export const lone = (e) => {
  const all = tokens([...e.parts.subject, ...e.parts.text]);

  return tokens(e.parts.text)
    .find((t) => all.indexOf(t) === all.lastIndexOf(t));
};

// Selects the token in the text and deletes it from the keyboard.
export const deleteToken = async (page, ui, value) => {
  await ui.body.locator(`[data-token="${value}"]`).evaluate((span) => {
    const r = document.createRange();

    r.selectNode(span);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.press("Delete");
};

export const PINNED = " Pinned by the e2e suite.";
export const DROP = "Drop your rewrite and keep the current wording?";
export const REWRITTEN = "rewritten, to apply";

export const saveRewrite = async (page, ui) => {
  await ui.rewrite.click();
  await ui.body.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(PINNED);
  await ui.editor.getByRole("button", { name: "Save rewrite" }).click();
};

// Presses Drop, answering its confirm yes or no. -> what it asked.
export const drop = async (page, ui, yes) => {
  const asked = new Promise((resolve) => page.once("dialog", (d) => {
    resolve(d.message());

    return yes ? d.accept() : d.dismiss();
  }));

  await ui.revert.click();

  return asked;
};

// The toolbar's line on the library: how many are to approve.
export const waiting = async (ui) =>
  Number((await ui.count.textContent()).match(/To approve: (\d+)/)[1]);
