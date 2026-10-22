// Every button that sends a request is the busy button (#299): while
// the request runs it shows the egg spinner and a busy word, and says
// aria-busy. layouts/partials/busy-button.html draws it and
// assets/scripts/utils/busy-button.js drives it.
//
// Left out, with its reason: the staging gate's sign-in page
// (netlify/functions/lib/gate-page.mjs) carries no script by design,
// and its form posts natively, so the browser shows the progress.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FAILED, failBusy, isBusy, onPress, setBusy, whileBusy,
} from "../assets/scripts/utils/busy-button.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const files = (dir, pattern) => readdirSync(join(ROOT, dir), {
  recursive: true, withFileTypes: true,
}).filter((e) => e.isFile() && pattern.test(e.name))
  .map((e) => relative(ROOT, join(e.parentPath, e.name)))
  .sort();

const read = (file) => readFileSync(join(ROOT, file), "utf8");

// A template without its Go comments, which may quote markup.
const markup = (file) => read(file)
  .replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, "");

const TEMPLATES = files("layouts", /\.html$/);
const SCRIPTS = files("assets/scripts", /\.m?js$/);

// The inventory on #299: every button that sends a request, by the
// template that draws it and its idle label.
const REQUEST_BUTTONS = [
  ["layouts/contact/single.html", "Send"],
  ["layouts/partials/news-signup.html", null],
  ["layouts/partials/order/wrap.html", "Pay and place your order"],
  ["layouts/partials/order/wrap.html", "Save changes"],
  ["layouts/login/single.html", "Email me a sign-in link"],
  ["layouts/account/single.html", "Sign out"],
  ["layouts/account/single.html", "Delete my details"],
  ["layouts/account/single.html", "Send"],
  ["layouts/account/single.html", "Save changes"],
  ["layouts/account/single.html", "Yes, cancel it"],
  ["layouts/partials/header/account-menu.html", "Sign out"],
  ["layouts/partials/staging-toolbar.html", "Set"],
  ["layouts/partials/staging-toolbar.html", "Reset"],
  ["layouts/partials/staging-toolbar.html", "Refresh"],
  ["layouts/partials/staging-toolbar.html", "Clear"],
  ["layouts/partials/staging-toolbar.html", "Run now"],
  ["layouts/partials/staging-toolbar.html", "6 AM"],
  ["layouts/partials/staging-toolbar.html", "8 AM"],
  ["layouts/partials/staging-toolbar.html", "6 PM"],
  ["layouts/partials/staging-toolbar.html", "Reset to defaults"],
  ["layouts/partials/staging-toolbar.html", "Reset to first visit"],
  ["layouts/partials/staging-toolbar.html", "Approve"],
  ["layouts/partials/staging-toolbar.html", "Withdraw approval"],
  ["layouts/partials/staging-toolbar.html", "Revert to the current wording"],
  ["layouts/partials/staging-toolbar.html", "Save rewrite"],
];

// The busy-button calls in a template, each as its dict's text.
const busyCalls = (file) => [...markup(file)
  .matchAll(/partial "busy-button\.html" \(dict ([^\n]*?)\) \}\}/g)]
  .map((m) => m[1]);

describe("busy buttons: every button that sends a request", () => {
  for (const [file, label] of REQUEST_BUTTONS) {
    it(`${file}: ${label ?? "its button"} is the busy button`, () => {
      const calls = busyCalls(file).filter((dict) => label === null
        || dict.includes(`"label" "${label}"`));

      assert.ok(calls.length, "no busy-button call with that label");
      for (const dict of calls) {
        assert.match(dict, /"busy" "[^"]+"/, "it needs a busy word");
      }
    });
  }

  it("no template writes a button that submits", () => {
    // A <button> with no type submits its form, so it sends a request.
    // The partial's own is the one allowed.
    const found = TEMPLATES
      .filter((file) => file !== "layouts/partials/busy-button.html")
      .flatMap((file) => [...markup(file)
        .matchAll(/<button\b[^>]*>/g)]
        .filter((m) => !/\btype="button"/.test(m[0]))
        .map((m) => `${file}: ${m[0]}`));

    assert.deepEqual(found, [], "use partials/busy-button.html");
  });

  it("every busy-button call is in the inventory", () => {
    const listed = new Set(REQUEST_BUTTONS.map(([file]) => file));
    const unlisted = TEMPLATES.filter((file) => busyCalls(file).length
      && !listed.has(file) && file !== "layouts/partials/busy-button.html");

    assert.deepEqual(unlisted, [], "add it to REQUEST_BUTTONS");
  });

  it("no script shows a button busy by hand", () => {
    // Swapping a button's label for a busy word ("Sending…") or
    // disabling it while a request runs is the helper's job. The fake
    // payment buttons (SQUARE_ENV=fake) stand in for Square's and
    // PayPal's own, so they are left out.
    const button = String.raw`\b\w*(?:submit|button|btn)\w*`;
    const byHand = [
      new RegExp(String.raw`${button}\.(?:textContent|innerText)\s*=\s*` +
        String.raw`["'\x60][^"'\x60]*ing(?:…|\.\.\.)?["'\x60]`, "i"),
      new RegExp(String.raw`${button}\.disabled\s*=\s*true\b`, "i"),
    ];
    const found = SCRIPTS
      .filter((file) => !file.startsWith("assets/scripts/fake/")
        && file !== "assets/scripts/utils/busy-button.js")
      .flatMap((file) => read(file).split("\n")
        .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
        .filter(({ line }) => byHand.some((re) => re.test(line))))
      .map(({ at, line }) => `${at}: ${line.trim()}`);

    assert.deepEqual(found, [], "use utils/busy-button.js");
  });
});

// A stand-in for the partial's button, enough for the helper.
const fakeButton = () => {
  const attrs = new Map();
  const face = () => {
    const own = new Map();

    return {
      setAttribute: (k, v) => own.set(k, v),
      getAttribute: (k) => own.get(k) ?? null,
    };
  };
  const faces = { ".busy-button-idle": face(), ".busy-button-busy": face() };

  return {
    dataset: {},
    classList: { contains: () => false },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    addEventListener(type, fn) {
      this.listener = fn;
    },
    querySelector: (selector) => faces[selector],
    faces,
  };
};

describe("busy buttons: the helper", () => {
  it("says aria-busy while busy, and drops it after", () => {
    const button = fakeButton();

    setBusy(button, true);
    assert.equal(isBusy(button), true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(
      button.faces[".busy-button-busy"].getAttribute("aria-hidden"), "false"
    );
    assert.equal(
      button.faces[".busy-button-idle"].getAttribute("aria-hidden"), "true"
    );

    setBusy(button, false);
    assert.equal(isBusy(button), false);
    assert.equal(button.getAttribute("aria-busy"), null);
    assert.equal(button.getAttribute("aria-disabled"), "false");
  });

  it("is idle again after a request fails", async () => {
    const button = fakeButton();

    await assert.rejects(
      whileBusy(button, Promise.reject(new Error("no"))), /no/
    );
    assert.equal(isBusy(button), false);
    assert.equal(button.getAttribute("aria-busy"), null);
  });

  it("onPress ignores a press while busy", async () => {
    const button = fakeButton();
    let runs = 0;
    let finish;

    onPress(button, () => {
      runs += 1;

      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    button.listener();
    button.listener();
    assert.equal(runs, 1);
    assert.equal(isBusy(button), true);
    finish();
  });

  it("failBusy goes idle and says so on the status line", () => {
    const button = fakeButton();
    const line = {
      textContent: "",
      classList: { contains: (name) => name === "busy-button-error" },
    };

    button.nextElementSibling = line;
    setBusy(button, true);
    failBusy(button);
    assert.equal(isBusy(button), false);
    assert.equal(line.textContent, FAILED);

    // The next try clears it, so the same words again are a change.
    setBusy(button, true);
    assert.equal(line.textContent, "");
    failBusy(button, "The site said no.");
    assert.equal(line.textContent, "The site said no.");
  });

  it("the partial writes the status line in the page, not hidden", () => {
    const partial = read("layouts/partials/busy-button.html");
    const tag = partial.match(/<span class="busy-button-error"[^>]*>/);

    assert.ok(tag, "the partial writes the line");
    assert.doesNotMatch(tag[0], /\bhidden\b/,
      "a hidden live region is not announced");
    assert.match(tag[0], /role="status"/);
  });

  it("failBusy on a button with no status line only goes idle", () => {
    const button = fakeButton();

    setBusy(button, true);
    failBusy(button);
    assert.equal(isBusy(button), false);
  });
});
