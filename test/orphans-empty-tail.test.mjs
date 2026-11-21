// Criteria test for #754's first box: the orphan pass leaves alone any
// last pair whose tail holds an empty inline element, so a value a
// script fills in later can still wrap. qa's scan on #753 found the
// pass wrapping such pairs on the order placed panel, the email-change
// confirmation and the contact page's sent message.
//
// Held out of every run by its name: `npm test` takes *.test.mjs only,
// so renaming it to orphans-empty-tail.test.mjs turns it on. Run it
// by hand with `node --test test/orphans-empty-tail.criteria.mjs`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { wrapLastWords } from "../bin/orphans/wrap.mjs";

const wrap = (html) => wrapLastWords(html).html;
const N = '<span class="text-nowrap">';

describe("#754 the orphan pass and script-filled values", () => {
  it("leaves alone any last pair whose tail holds an empty inline " +
    "element, so a script-filled value can wrap", () => {
    // Empty at build time: each is left exactly as it was.
    for (const html of [
      // The partial layouts/partials/email-confirm.html, on /account/
      // and /login/.
      "<p>Change your email address to <strong data-confirm-email>"
        + "</strong>?</p>",
      // The sent message in layouts/contact/single.html.
      '<p class="mb-0">\n  Your message is on its way to the farm.'
        + " We'll answer by\n  email to <strong data-contact-email>"
        + "</strong>.\n</p>",
      // A list item that ends in its empty value, as #723's panel did.
      "<li>Order number: <strong data-x></strong></li>",
      "<li>Your order was paid with <strong data-x></strong></li>",
      // The other inline elements the pass reads.
      "<p>Delivered to <b data-x></b></p>",
      "<p>Picked up on <em data-x></em>.</p>",
      "<li>Ready at <i data-x></i></li>",
      // An empty value between the pair's two words.
      "<li>Paid <em data-x></em> today</li>",
    ]) {
      const { html: out, count } = wrapLastWords(html);

      assert.equal(out, html, `left alone: ${JSON.stringify(html)}`);
      assert.equal(count, 0, `no pair kept: ${JSON.stringify(html)}`);
    }

    // Filled at build time: the usual text-nowrap pair, as before.
    assert.equal(
      wrap("<p>Change your email address to <strong data-confirm-email>"
        + "Jo</strong>?</p>"),
      `<p>Change your email address ${N}to <strong data-confirm-email>`
        + "Jo</strong>?</span></p>");
    assert.equal(
      wrap("<li>Order number: <strong data-x>A1B2</strong></li>"),
      `<li>Order ${N}number: <strong data-x>A1B2</strong></span></li>`);
    assert.equal(
      wrap("<li>Paid <em data-x>by card</em> today</li>"),
      `<li>Paid <em data-x>by </em>${N}<em data-x>card</em> today`
        + "</span></li>");
  });
});
