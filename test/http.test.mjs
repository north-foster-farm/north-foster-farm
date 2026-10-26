import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noCopy } from "../netlify/functions/lib/http.mjs";

describe("noCopy", () => {
  it("gives a path with no query one of its own", () => {
    assert.equal(noCopy("/account/"), "/account/?via=link");
  });

  it("puts the query before a fragment", () => {
    assert.equal(noCopy("/account/#confirm=t&email=a%40b.c"),
      "/account/?via=link#confirm=t&email=a%40b.c");
  });

  it("leaves a next with a query of its own alone", () => {
    assert.equal(noCopy("/login/?error=unknown"), "/login/?error=unknown");
    assert.equal(noCopy("/order/?add=eggs#pay"), "/order/?add=eggs#pay");
  });

  it("does not take a ? inside the fragment for a query", () => {
    assert.equal(noCopy("/account/#a?b"), "/account/?via=link#a?b");
  });
});
