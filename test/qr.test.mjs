// The join QR code's drawing (#495). The matrix is qrcode-generator's;
// these hold the SVG around it: well formed, the same for the same
// link, and the size level M gives a join link.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { qrSvg } from "../netlify/functions/lib/qr.mjs";

const LINK = "https://www.northfosterfarm.com/join/?t=" +
  "q3Jm0f9xR2kVtZ8pLwE4sNbY7cH1dAoUeGiK6uXyTzW";

describe("the join QR code", () => {
  it("is one well-formed SVG element for a join link", () => {
    const svg = qrSvg(LINK, { title: "Join Valley Fitness" });
    const open = svg.match(/^<svg ([^>]*)>/);

    assert.ok(open, "starts with an svg tag");
    assert.ok(svg.endsWith("</svg>"));
    assert.equal(svg.match(/<svg[ >]/g).length, 1);
    assert.match(open[1], /^xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);

    // Every tag closes, in order, and nothing sits outside a tag.
    const tags = /<(\/?)([a-z]+)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*(\/?)>/g;
    const stack = [];

    for (const [, close, tag, , self] of svg.matchAll(tags)) {
      if (close) assert.equal(stack.pop(), tag);
      else if (!self) stack.push(tag);
    }
    assert.deepEqual(stack, []);
    assert.equal(svg.replace(tags, ""), "Join Valley Fitness");

    const path = svg.match(/<path fill="#000" d="([^"]*)"\/>/)[1];

    assert.match(path, /^(M\d+ \d+h\d+v\d+h-\d+z)+$/);
  });

  it("gives the same SVG for the same link", () => {
    assert.equal(qrSvg(LINK), qrSvg(LINK));
    assert.equal(qrSvg(LINK, { title: "Join G" }),
      qrSvg(LINK, { title: "Join G" }));
    assert.notEqual(qrSvg(LINK), qrSvg(`${LINK}x`));
  });

  it("is level M's size for a join link, with a four-module quiet zone",
    () => {
      // 83 bytes: version 5 (37 modules) at level M; Q or H would need
      // version 6 or 7.
      const svg = qrSvg(LINK, { scale: 4 });
      const side = (37 + 8) * 4;

      assert.match(svg, new RegExp(
        `viewBox="0 0 ${side} ${side}" width="${side}" height="${side}"`));

      // The finder patterns' top rows, seven modules wide, in from the
      // quiet zone at the top left and the top right.
      assert.ok(svg.includes(`M16 16h28v4h-28z`));
      assert.ok(svg.includes(`M${(37 - 7 + 4) * 4} 16h28v4h-28z`));
    });

  it("escapes the title to entities, keeping every character", () => {
    const svg = qrSvg(LINK, { title: "Join <the> \"Smith & Co's\" group" });
    const kept = "Join &lt;the&gt; &quot;Smith &amp; Co&#39;s&quot; group";

    assert.ok(svg.includes(`<title>${kept}</title>`));
    assert.ok(svg.includes(`aria-label="${kept}"`));
    assert.ok(!svg.includes("<the>"));
    assert.ok(!svg.includes("Smith & Co"));
  });

  it("refuses text that is not ASCII", () => {
    assert.throws(() => qrSvg("https://example.com/café"), /ASCII/);
  });
});
