// The gate's pages (#294): the site's header and logo, James's words in
// his order, nothing loaded from anywhere, and an accessible form.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { render as renderFonts } from "../bin/gate-fonts.mjs";
import { render } from "../bin/gate-logo.mjs";
import { handle } from "../netlify/functions/gate.mjs";
import {
  COPY, checkEmailPage, invalidLinkPage, signInPage,
} from "../netlify/functions/lib/gate-page.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const root = join(import.meta.dirname, "..");
const pages = {
  signIn: signInPage({ next: "/order/" }),
  sent: checkEmailPage(),
  invalid: invalidLinkPage(),
};

// Where each piece of the page first appears.
const order = (html, parts) => parts.map((p) => {
  const at = html.indexOf(p);

  assert.ok(at >= 0, `missing: ${p}`);

  return at;
});
const ascending = (xs) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

describe("the gate's pages", () => {
  it("load nothing: no script, stylesheet, font, image or frame", () => {
    for (const [name, html] of Object.entries(pages)) {
      assert.ok(!/[<](script|link|img|iframe|object|embed)\b/i.test(html),
        name);
      assert.ok(!/@import|src=/i.test(html), name);

      // The only url() is Aller, regular and bold, inline.
      const urls = html.match(/url\(/gi) || [];
      const fonts = html.match(/url\(data:font\/woff2;base64,/g) || [];

      assert.equal(urls.length, 2, name);
      assert.equal(fonts.length, 2, name);
    }
  });

  it("set the site's Aller, regular and bold, from its own files", () => {
    const module = readFileSync(
      join(root, "netlify/functions/lib/gate-fonts.mjs"), "utf8");

    assert.equal(module, renderFonts(),
      "run node bin/gate-fonts.mjs: the Aller files changed");
    assert.match(pages.signIn, /font-weight: 400;\s+src: url\(data:font/);
    assert.match(pages.signIn, /font-weight: 700;\s+src: url\(data:font/);
  });

  it("carry the site's header: the logo, centered, and no nav", () => {
    for (const html of Object.values(pages)) {
      assert.match(html, /class="site-header"/);
      assert.match(html, /class="site-mark"[^>]*><svg/);
      assert.match(html, /class="site-wordmark"[^>]*><svg/);
      assert.match(html, /class="site-stripe"/);
      assert.ok(!/[<]nav\b/.test(html), "no navigation");
    }
  });

  it("keep the logo the site's own SVGs", () => {
    const module = readFileSync(
      join(root, "netlify/functions/lib/gate-logo.mjs"), "utf8");

    assert.equal(module, render(),
      "run node bin/gate-logo.mjs: the logo SVGs changed");
  });

  it("put the sign-in page's words in James's order", () => {
    const html = pages.invalid;

    assert.ok(ascending(order(html, [
      `>${COPY.heading}</h1>`,
      `href="https://www.northfosterfarm.com/">${COPY.production}</a>`,
      COPY.ask,
      COPY.invalid,
      "type=\"email\"",
      "type=\"submit\"",
    ])));
    assert.equal(COPY.production, "Production: northfosterfarm.com");
    assert.equal(COPY.invalid,
      "That link has expired or was already used. Try again.");
    assert.equal(COPY.ask, "Enter your email address. If you're allowed " +
      "to access the site, you'll receive a link. Click it to sign in.");
  });

  it("say the link was sent, with a button-styled way back", () => {
    const html = pages.sent;

    assert.ok(ascending(order(html, [
      `>${COPY.heading}</h1>`, COPY.production,
      "Use the link to sign in. The link is single use and expires " +
        "after 15 minutes.",
      `<a class="btn" href="/api/gate/signin">${COPY.again}</a>`,
    ])));
  });

  it("label the field, and announce and tie the message to it", () => {
    assert.match(pages.signIn, /[<]label for="email">Email address/);
    assert.ok(!pages.signIn.includes("role=\"alert\""), "no message");
    assert.match(pages.invalid,
      /id="gate-message" role="alert">That link has expired/);
    assert.match(pages.invalid,
      /aria-describedby="gate-message" autofocus>/);
    assert.ok(!pages.signIn.includes("autofocus"), "no focus unasked");
  });

  it("give the button and the link the same brand style and states",
    () => {
      for (const state of [":focus-visible", ":not(.btn-link):hover",
        ":not(.btn-link):active", ":not(.btn-link):active:focus-visible"]) {
        assert.ok(pages.signIn.includes(`.btn${state} {`), state);
      }
      assert.match(pages.signIn, /[<]button class="btn" type="submit">/);
    });

  it("is what an invalid link gets from the function", async () => {
    const res = await handle(
      new Request("https://stg.example/api/gate/verify?token=nope"),
      { stores: testStores(), env: { SITE_CONTEXT: "branch-deploy" } });

    assert.equal(res.status, 401);
    assert.equal(await res.text(), pages.invalid);
  });
});
