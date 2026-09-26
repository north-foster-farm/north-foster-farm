import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import postcss from "postcss";

const hoverOnly = createRequire(import.meta.url)(
  "../bin/postcss/hover-only.js");

// Whitespace aside: nodes the plugin adds carry none of their own.
const squash = (css) => css.replace(/\s*([{};])\s*/g, "$1").trim();

const same = async (css, expected) => {
  const out = await postcss([hoverOnly()]).process(css, { from: undefined });

  assert.equal(squash(out.css), squash(expected));
};

describe("the hover-only plugin", () => {
  it("moves a hover rule into a hover media query", async () => {
    await same(".btn:hover { color: red; }",
      "@media (hover: hover) { .btn:hover { color: red; } }");
  });

  it("leaves the rest of a selector list where it was", async () => {
    await same("a:hover, a:focus-visible { color: red; }",
      "a:focus-visible { color: red; } " +
      "@media (hover: hover) { a:hover { color: red; } }");
  });

  it("keeps the rule's place among its neighbors", async () => {
    await same(".a { top: 0; } .a:hover { top: 1px; } " +
      ".a:active { top: 2px; }",
    ".a { top: 0; } @media (hover: hover) { .a:hover { top: 1px; } } " +
      ".a:active { top: 2px; }");
  });

  it("nests inside an existing media query", async () => {
    await same("@media (min-width: 1px) { .a:hover { top: 0; } }",
      "@media (min-width: 1px) { " +
      "@media (hover: hover) { .a:hover { top: 0; } } }");
  });

  it("leaves hover media and other selectors alone", async () => {
    const css = "@media (hover: hover) { .a:hover { top: 0; } } " +
      ".a:active { top: 0; } .a-hovered { top: 0; }";

    await same(css, css);
  });
});
