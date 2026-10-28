// The join token leaves the address bar once /join/ reads it, and is
// never copied into another URL such as /login/?next= (#495, the
// coordinator's security review).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  KEY, dropToken, takeToken, tokenDead,
} from "../assets/scripts/join/token.mjs";

const TOKEN = "Abc123_-xyzXYZ0987654321abcdefghijklmnopqrs";

const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

// A tab: its address, its history and its sessionStorage.
const tab = (href) => {
  const items = new Map();
  const calls = [];

  return {
    calls,
    items,
    location: { href },
    history: {
      state: { kept: true },
      replaceState: (state, title, url) => calls.push({ state, url }),
    },
    storage: () => ({
      getItem: (k) => (items.has(k) ? items.get(k) : null),
      setItem: (k, v) => items.set(k, v),
      removeItem: (k) => items.delete(k),
    }),
  };
};

describe("the join page's token", () => {
  it("drops t from the address bar once read", () => {
    const t = tab(`https://example.test/join/?t=${TOKEN}&x=1#top`);

    assert.equal(takeToken(t), TOKEN);
    assert.deepEqual(t.calls, [
      { state: { kept: true }, url: "/join/?x=1#top" },
    ]);
  });

  it("leaves a bare /join/ address with no query", () => {
    const t = tab(`https://example.test/join/?t=${TOKEN}`);

    takeToken(t);
    assert.equal(t.calls[0].url, "/join/");
    assert.ok(!t.calls[0].url.includes(TOKEN));
  });

  it("keeps it for this tab, so a reload still works", () => {
    const t = tab(`https://example.test/join/?t=${TOKEN}`);

    takeToken(t);
    t.location.href = "https://example.test/join/";
    assert.equal(takeToken(t), TOKEN);
    assert.equal(t.calls.length, 1);
  });

  it("forgets it once spent or dead", () => {
    const t = tab(`https://example.test/join/?t=${TOKEN}`);

    takeToken(t);
    dropToken(t);
    assert.equal(t.items.has(KEY), false);
    t.location.href = "https://example.test/join/";
    assert.equal(takeToken(t), "");
  });

  it("still reads it when the browser blocks storage", () => {
    const t = tab(`https://example.test/join/?t=${TOKEN}`);

    t.storage = () => {
      throw new Error("blocked");
    };
    assert.equal(takeToken(t), TOKEN);
    assert.equal(t.calls[0].url, "/join/");
    assert.doesNotThrow(() => dropToken(t));
  });

  it("is never copied into the sign-in page's next", () => {
    const script = read("assets/scripts/join/main.js");
    const page = read("layouts/join/single.html");

    assert.doesNotMatch(script, /login\/\?next=|location\.search/);
    assert.doesNotMatch(page, /href="[^"]*login/);
  });

  it("is dropped only when the server says it is dead", () => {
    assert.equal(tokenDead(404), true);
    assert.equal(tokenDead(429), true);
    // A failed fetch (0), a server error or maintenance keeps it, so a
    // reload on better signal can still join.
    for (const status of [0, undefined, 500, 502, 503]) {
      assert.equal(tokenDead(status), false, String(status));
    }
  });

  it("asks before dropping it on the check's answer", () => {
    const script = read("assets/scripts/join/main.js");
    const check = script.slice(script.indexOf("/api/join/check"),
      script.indexOf("data-join-group"));

    assert.match(check, /if \(tokenDead\(status\)\) \{\s*dropToken\(tab\)/);
    assert.equal(check.match(/dropToken\(/g).length, 1);
  });
});
