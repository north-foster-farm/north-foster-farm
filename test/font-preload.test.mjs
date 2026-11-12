// The fonts the head preloads (#565, partials/head/fonts.html) are
// faces _fonts.scss declares, at the same URL, or the face would fetch
// its file again after the paint and the header would still move.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url),
  "utf8");

const preloads = [...read("layouts/partials/head/fonts.html")
  .matchAll(/<link rel="preload" href="([^"]+)" as="font"([^>]*)>/g)];
const faces = read("assets/styles/_fonts.scss");

describe("the font preloads (#565)", () => {
  it("preloads the regular and the bold", () => {
    assert.deepEqual(preloads.map(([, href]) => href), [
      "/fonts/aller-regular.woff2", "/fonts/aller-bold.woff2",
    ]);
  });

  for (const [, href, rest] of preloads) {
    it(`${href} is a face's URL and a file`, () => {
      assert.ok(faces.includes(`url("${href}") format("woff2")`), href);
      assert.ok(existsSync(new URL(`../static${href}`, import.meta.url)),
        href);
    });

    // A font is fetched in CORS mode, so a preload without it is
    // fetched twice.
    it(`${href} is fetched as the face fetches it`, () => {
      assert.match(rest, /type="font\/woff2" crossorigin/);
    });
  }
});
