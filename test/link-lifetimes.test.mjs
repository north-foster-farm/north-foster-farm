// #303: every link lifetime shown to people is the one the code
// enforces. Each page and email that states one is held here to the
// constant its link is issued with, so changing either alone fails:
// the sign-in link (lib/auth.mjs LINK_TTL), the email-address change
// link (#240, issued by the same requestLink with LINK_TTL) and the
// staging gate's link (lib/gate.mjs LINK_TTL).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LINK_TTL as SIGN_IN_TTL } from "../netlify/functions/lib/auth.mjs";
import { LINK_TTL as GATE_TTL } from "../netlify/functions/lib/gate.mjs";
import { linkText } from "../netlify/functions/lib/gate-mail.mjs";
import { COPY } from "../netlify/functions/lib/gate-page.mjs";
import * as templates from "../netlify/functions/lib/templates.mjs";

const root = join(import.meta.dirname, "..");
const MINUTE = 60_000;
const signIn = SIGN_IN_TTL / MINUTE;
const gate = GATE_TTL / MINUTE;
const data = (name) => JSON.parse(
  readFileSync(join(root, "data", name), "utf8")
);

// Every "N minutes" in a text.
const stated = (text) => [...String(text).matchAll(/(\d+)\s+minutes/g)]
  .map((m) => Number(m[1]));

describe("link lifetimes", () => {
  it("are what the data files say, today 15 minutes each", () => {
    assert.equal(signIn, data("accounts.json").signInLinkMinutes);
    assert.equal(gate, data("gate.json").linkMinutes);
  });

  it("the sign-in page states the sign-in link's", () => {
    const page = readFileSync(join(root, "layouts/login/single.html"),
      "utf8");
    const sent = /data-login-sent-text>([^\n]*)/.exec(page);

    assert.ok(sent, "the after-send text is on the page");
    assert.match(page,
      /\$minutes := hugo\.Data\.accounts\.signInLinkMinutes/);
    assert.match(sent[1], /expires in \{\{ \$minutes \}\} minutes\./);
    assert.deepEqual(stated(page), [], "no minutes written out by hand");
  });

  it("the sign-in email states the sign-in link's", () => {
    const m = templates.magicLink("a@example.com", "https://x/t");

    assert.deepEqual(stated(m.text), [signIn]);
  });

  it("the email change email states the sign-in link's (#240)", (t) => {
    if (!templates.emailChangeLink) {
      t.skip("the email change has not landed");

      return;
    }

    const m = templates.emailChangeLink("a@example.com", "https://x/t");

    assert.deepEqual(stated(m.text), [signIn]);
  });

  it("the staging gate's page and email state the gate link's", () => {
    assert.deepEqual(stated(COPY.sent), [gate]);
    assert.deepEqual(stated(linkText("https://x/t")), [gate]);
  });

  // A lifetime typed into a page or a script, rather than read from
  // its constant, would drift from it unseen.
  it("is never written out by hand in the site's words", () => {
    // A sentence about a link that gives it a number of minutes.
    const LIFETIME = /\blinks?\b[^.]{0,120}?\b\d+\s+minutes/i;
    const places = ["content", "layouts", "assets/scripts",
      "netlify/functions"];
    const found = [];

    for (const place of places) {
      for (const f of readdirSync(join(root, place), { recursive: true })) {
        if (!/\.(md|html|js|mjs)$/.test(f)) continue;

        const text = readFileSync(join(root, place, f), "utf8");

        if (LIFETIME.test(text)) found.push(join(place, f));
      }
    }

    assert.deepEqual(found, []);
  });
});
