import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { wrapLastWords } from "../bin/orphans/wrap.mjs";

const wrap = (html) => wrapLastWords(html).html;
const same = (html) => assert.equal(wrap(html), html);
const N = '<span class="text-nowrap">';

describe("keeping the last two words together", () => {
  it("wraps a paragraph that ends in plain words", () => {
    assert.equal(wrap("<p>Eggs from our own hens.</p>"),
      `<p>Eggs from our ${N}own hens.</span></p>`);
  });

  it("covers headings, list items and the other prose elements", () => {
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6", "li", "dd",
      "dt", "figcaption", "td", "th", "label", "summary", "caption"]) {
      assert.equal(wrap(`<${tag}>One two three</${tag}>`),
        `<${tag}>One ${N}two three</span></${tag}>`, tag);
    }
  });

  it("leaves other elements alone", () => {
    same("<div>One two three</div>");
    same("<a href=\"/\">One two three</a>");
    same("<button>One two three</button>");
  });

  it("allows b, strong, em and i in and around the words", () => {
    assert.equal(wrap("<p>Our <b>pasture</b>-raised <em>eggs</em>.</p>"),
      `<p>Our ${N}<b>pasture</b>-raised <em>eggs</em>.</span></p>`);
    assert.equal(wrap("<p>Order <strong>by Monday</strong></p>"),
      `<p>Order ${N}<strong>by Monday</strong></span></p>`);
    assert.equal(wrap("<p>One two <i>three</i></p>"),
      `<p>One ${N}two <i>three</i></span></p>`);
  });

  it("closes and reopens an emphasis that starts before the pair", () => {
    assert.equal(wrap("<p>Our <em>very good eggs</em>.</p>"),
      `<p>Our <em>very </em>${N}<em>good eggs</em>.</span></p>`);
    assert.equal(
      wrap('<p>A <strong class="x"><em>one two three</em></strong></p>'),
      `<p>A <strong class="x"><em>one </em></strong>${N}`
      + '<strong class="x"><em>two three</em></strong></span></p>');
  });

  it("takes in a text-nowrap span around one word", () => {
    assert.equal(
      wrap('<p>Or our drop site in <span class="text-nowrap">'
        + "Scituate</span>.</p>"),
      `<p>Or our drop site ${N}in <span class="text-nowrap">`
      + "Scituate</span>.</span></p>");
  });

  it("adds nothing when the last words are inside other markup", () => {
    same('<p>See <a href="/order/">the order page</a></p>');
    same('<p>Proudly raised in <span class="text-nowrap">Rhode'
      + " Island</span>.</p>");
    same('<p>Read <span class="x">this one</span></p>');
    same("<p>Run it with <code>npm test</code></p>");
    same("<p>One two <a href=\"/\">three</a>.</p>");
  });

  it("adds nothing when the first word runs into other markup", () => {
    same('<p>Read <a href="/">the</a>last two</p>');
    same('<p>See <em>it</em><a href="/">here</a>now please</p>');
    same("<p>One two<br>three four</p>");
  });

  it("adds nothing to an element of one word", () => {
    same("<p>Hello</p>");
    same("<p></p>");
    same("<li>  Free  </li>");
  });

  it("wraps an element of just two words (#303)", () => {
    assert.equal(wrap("<p>Shop now</p>"), `<p>${N}Shop now</span></p>`);
    assert.equal(wrap("<li>  Free delivery  </li>"),
      `<li>  ${N}Free delivery  </span></li>`);
    assert.equal(wrap("<h2><em>Our eggs</em></h2>"),
      `<h2>${N}<em>Our eggs</em></span></h2>`);
    assert.equal(wrap('<p>Read <span class="text-nowrap">one</span></p>'),
      `<p>${N}Read <span class="text-nowrap">one</span></span></p>`);
    same("<th>Delivery fee</th>");
    same("<td>West Warwick</td>");
    assert.equal(wrap("<td>Free over $100</td>"),
      `<td>Free ${N}over $100</span></td>`);
    assert.equal(wrap('<p><a href="/">Order</a> by Monday</p>'),
      `<p><a href="/">Order</a> ${N}by Monday</span></p>`);
  });

  it("skips URLs and email addresses", () => {
    same("<p>Write to us at info@example.com</p>");
    same("<p>Write to info@example.com today</p>");
    same("<p>Write to info&#64;example.com today</p>");
    same("<p>Visit us at https://example.com</p>");
    same("<p>Visit us at www.example.com</p>");
    same("<p>Visit us at WWW.example.com</p>");
  });

  it("skips a word longer than 14 characters", () => {
    same("<p>It is all about uncharacteristically good</p>");
    same("<p>We sell good uncharacteristically</p>");
    assert.equal(wrap("<p>We sell fifteencharsxx okay</p>"),
      `<p>We sell ${N}fifteencharsxx okay</span></p>`);
    same("<p>We sell fifteencharsxxx okay</p>");
  });

  it("counts an entity as one character", () => {
    const fourteen = "&amp;".repeat(14);
    assert.equal(wrap(`<p>Ham &amp; cheese ${fourteen}</p>`),
      `<p>Ham &amp; ${N}cheese ${fourteen}</span></p>`);
    same(`<p>Ham &amp; cheese ${fourteen}&amp;</p>`);
  });

  it("treats a no-break space as part of a word", () => {
    assert.equal(wrap("<p>Pick up on Main&nbsp;Street today</p>"),
      `<p>Pick up on ${N}Main&nbsp;Street today</span></p>`);
  });

  it("keeps trailing whitespace inside the element", () => {
    assert.equal(wrap("<p>\n  One two three\n</p>"),
      `<p>\n  One ${N}two three\n</span></p>`);
  });

  it("wraps across a line break in the source", () => {
    assert.equal(wrap("<p>One two\nthree</p>"),
      `<p>One ${N}two\nthree</span></p>`);
  });

  it("works on nested prose, inner element only", () => {
    assert.equal(wrap("<li><p>One two three</p></li>"),
      `<li><p>One ${N}two three</span></p></li>`);
    assert.equal(wrap("<blockquote><p>One two three</p></blockquote>"),
      `<blockquote><p>One ${N}two three</span></p></blockquote>`);
  });

  it("leaves script, style, pre, code, textarea and SVG untouched", () => {
    same("<script>var p = '<p>One two three</p>';</script>");
    same("<style>p::after { content: '<p>a b c</p>'; }</style>");
    same("<pre><p>One two three</p></pre>");
    same("<code><p>One two three</p></code>");
    same("<textarea><p>One two three</p></textarea>");
    same("<svg><title>One two three</title>"
      + "<foreignObject><p>One two three</p></foreignObject></svg>");
    same("<math><mtext><p>One two three</p></mtext></math>");
  });

  it("leaves attributes, comments and the head alone", () => {
    same("<title>Eggs and more | North Foster Farm</title>"
      + '<meta name="description" content="One two three">');
    same("<p>One two <!-- three --></p>");
    same('<p>One two <img alt="three four" src="x.png"></p>');
  });

  it("skips an element that never closes", () => {
    same("<ul><li>One two three<li>Four five six</ul>");
  });

  it("wraps every element in a page and counts them", () => {
    const { html, count } = wrapLastWords(
      "<h1>One two three</h1><p>Four five six</p><p>Seven</p>");
    assert.equal(count, 2);
    assert.equal(html, `<h1>One ${N}two three</span></h1>`
      + `<p>Four ${N}five six</span></p><p>Seven</p>`);
  });

  it("changes nothing on a second run", () => {
    for (const html of [
      "<p>Eggs from our own hens.</p>",
      "<p>Our <em>very good eggs</em>.</p>",
      '<p>Or our drop site in <span class="text-nowrap">Scituate</span>.</p>',
      "<p>Shop now</p>",
    ]) {
      const once = wrap(html);
      assert.notEqual(once, html);
      assert.equal(wrap(once), once);
    }
  });
});

// The list items we know are flex rows: their text must sit in a span
// of its own, which the pass leaves alone. Bare text there would get a
// nowrap span that becomes a flex item of its own (#303).
describe("the flex rows the pass must not split", () => {
  const read = (path) => readFileSync(new URL(`../${path}`,
    import.meta.url), "utf8");
  const items = (html, from) => {
    const list = html.slice(html.indexOf(from));

    return list.slice(0, list.indexOf("</ul>")).match(/<li\b[\s\S]*?<\/li>/g)
      || [];
  };

  it("the map key keeps each label in its own span", () => {
    const lis = items(read("layouts/partials/map.html"),
      '<ul class="map-key-areas');

    assert.ok(lis.length >= 4);
    for (const li of lis) {
      // A label may end in a visually hidden span, for screen readers.
      const hidden = '(<span class="visually-hidden">[^<]+</span>)?';

      assert.match(li, new RegExp(`<span>[^<]+${hidden}</span></li>$`), li);
    }
  });

  it("the home place cards keep each fact in its own span", () => {
    const lis = items(read("layouts/partials/home/ways.html"),
      '<ul class="place-facts');

    assert.equal(lis.length, 1);
    assert.match(lis[0], /<span>\{\{[^<]+\}\}<\/span>\s*<\/li>$/);
  });

  it("leaves that shape alone", () => {
    same('<li><span class="map-swatch"></span><span>$5 delivery</span>'
      + "</li>");
  });
});

describe("hostile markup", () => {
  it("reads a long attribute list in linear time (CodeQL js/redos)", () => {
    for (const attrs of [
      `${"a ".repeat(50000)}!=`,
      `${"a=b".repeat(50000)}!=`,
      `${'="'.repeat(50000)}`,
    ]) {
      const html = `<p>One two three</p><A ${attrs} <p>x y z</p>`;
      const start = Date.now();
      wrapLastWords(html);
      assert.ok(Date.now() - start < 1000);
    }
  });

  it("still reads quoted values holding a > and a trailing slash", () => {
    assert.equal(wrap('<p title="a > b">One two three</p>'),
      `<p title="a > b">One ${N}two three</span></p>`);
    same('<p>One two<br class="x" /></p>');
  });
});
