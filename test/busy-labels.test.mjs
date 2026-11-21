// Criteria tests for #558, the busy labels. James decided on
// 2026-11-18: a form's busy label is "Submitting" and an email link's
// is "Sending"; the contact form, which sends a message, keeps
// "Sending", and the written rule names that exception.
//
// Held out of `npm test` until the change lands: the glob there is
// test/**/*.test.mjs. Run it alone with
//   node --import ./test/setup.mjs --test test/busy-labels.criteria.mjs
// and turn it on, once it passes, with
//   git mv test/busy-labels.criteria.mjs test/busy-labels.test.mjs
//
// Written by the wording-tests agent from the criteria alone. Its
// expectations are closed to the implementer (~/.claude/CLAUDE.md,
// "Tests and implementation come from different agents").

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const read = (file) => readFileSync(join(ROOT, file), "utf8");

const files = (dir, pattern) => readdirSync(join(ROOT, dir), {
  recursive: true, withFileTypes: true,
}).filter((e) => e.isFile() && pattern.test(e.name))
  .map((e) => relative(ROOT, join(e.parentPath, e.name)))
  .sort();

// A template without its Go comments, which may quote markup. The
// replace runs until nothing changes: one pass can join the pieces
// around a comment into a new one.
const markup = (text) => {
  let before;
  let after = text;

  do {
    before = after;
    after = before.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, "");
  } while (after !== before);

  return after;
};

// The busy-button calls in some markup, each as { label, busy }.
const busyCalls = (text) => [...markup(text)
  .matchAll(/partial "busy-button\.html" \(dict ([^\n]*?)\) \}\}/g)]
  .map(([, dict]) => ({
    dict,
    label: dict.match(/"label" (\([^)]*\)|"[^"]*")/)?.[1],
    busy: dict.match(/"busy" "([^"]*)"/)?.[1],
  }));

// The text of a template from a marker to the first end after it.
const slice = (file, start, end) => {
  const text = read(file);
  const from = text.indexOf(start);

  assert.notEqual(from, -1, `${file} has ${start}`);
  const to = text.indexOf(end, from);

  assert.notEqual(to, -1, `${file} closes ${start} with ${end}`);

  return text.slice(from, to);
};

// Every busy button whose busy word is "Sending" or "Submitting" on
// 2026-11-18, by what it does. Each is found by the markup around it
// and its idle label.
const ACCOUNT = "layouts/account/single.html";
const BUTTONS = [
  // Forms: "Submitting".
  { what: "the account page's Help form (#support-form)",
    file: ACCOUNT, start: 'id="support-form"', end: "</form>",
    label: '"Send"', busy: "Submitting" },
  { what: "the account page's Report a problem form (tpl-return)",
    file: ACCOUNT, start: 'id="tpl-return"', end: "</template>",
    label: '"Send"', busy: "Submitting" },
  // The contact form sends a message: "Sending", the rule's exception.
  { what: "the contact form",
    file: "layouts/contact/single.html", start: 'id="contact-submit"',
    label: '"Send"', busy: "Sending" },
  // Email links: "Sending".
  { what: "the sign-in link (/login)",
    file: "layouts/login/single.html", start: 'id="login-submit"',
    label: '"Send a sign-in link"', busy: "Sending" },
  { what: "the join link (/join)",
    file: "layouts/join/single.html", start: 'id="join-submit"',
    label: '"Send my link"', busy: "Sending" },
  { what: "the invite page's sign-in link (/invite, #718)",
    file: "layouts/invite/single.html", start: 'id="invite-submit"',
    label: '"Send my link"', busy: "Sending" },
  { what: "the account page's new email address link",
    file: ACCOUNT, start: 'id="email-change-send"',
    label: '"Send link"', busy: "Sending" },
  { what: "Farm news sign-up, which mails a confirmation link",
    file: "layouts/partials/farm-list.html", start: "data-farm-list-form",
    end: "</form>", label: '(.button | default "Sign me up")',
    busy: "Sending" },
];

// The one call in a button's stretch of its template.
const callOf = (button) => {
  const text = button.end
    ? slice(button.file, button.start, button.end)
    : read(button.file);
  // Without an end, the button's own id marks it: id="x" in the
  // markup is "id" "x" in the partial's dict.
  const id = button.end ? null : button.start.match(/id="([^"]+)"/)[1];
  const calls = busyCalls(text).filter((c) => c.label === button.label
    && (!id || c.dict.includes(`"id" "${id}"`)));

  assert.equal(calls.length, 1,
    `one busy button for ${button.what} in ${button.file}`);

  return calls[0];
};

describe("#558: busy labels", () => {
  it("each busy label is \"Submitting\" for a form and \"Sending\" for "
    + "an email link, the contact form keeping \"Sending\"", () => {
    for (const button of BUTTONS) {
      assert.equal(callOf(button).busy, button.busy, button.what);
    }

    // No other busy button says either word, so a new one is added to
    // the list above, classed as a form or an email link.
    const listed = BUTTONS.map(callOf).map((c) => c.dict);
    const others = files("layouts", /\.html$/).flatMap((file) =>
      busyCalls(read(file))
        .filter((c) => ["Sending", "Submitting"].includes(c.busy))
        .filter((c) => !listed.includes(c.dict))
        .map((c) => `${file}: ${c.label} says ${c.busy}`));

    assert.deepEqual(others, [], "every Sending or Submitting is listed");

    // Nor does a script set a busy word of its own.
    const scripted = files("assets/scripts", /\.m?js$/).filter((file) =>
      /["'`](Sending|Submitting)\b/.test(read(file)));

    assert.deepEqual(scripted, [], "no script writes a busy word");
  });

  it("the written rule names the contact form as the exception", () => {
    // The rule may live in the repo's CLAUDE.md (its #400 house rules)
    // or in any doc under docs/. One paragraph of it gives "Submitting"
    // for forms, "Sending" for email links, and the contact form's
    // "Sending" as the exception.
    const docs = ["CLAUDE.md", ...files("docs", /\.md$/)];
    const paragraphs = docs.flatMap((file) => read(file).split(/\n\s*\n/)
      .map((text) => ({ file, text: text.replace(/\s+/g, " ") })));
    const rule = paragraphs.filter(({ text }) =>
      /Submitting/.test(text) && /Sending/.test(text)
        && /forms?\b/i.test(text) && /email links?/i.test(text)
        && /contact form/i.test(text));

    assert.ok(rule.length > 0,
      "a paragraph with Submitting for forms, Sending for email links "
        + "and the contact form's exception");
  });
});
