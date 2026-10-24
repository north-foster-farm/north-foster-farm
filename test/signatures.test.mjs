import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  alone, library, missing, render, entry,
} from "../netlify/functions/lib/signatures.mjs";
import { COOKIE } from "../netlify/functions/lib/gate.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/staging.mjs";

const ID = "owner-session-id-0123456789abcdef";
const env = { CONTEXT: "branch-deploy", GATE_TOOLBAR_EMAIL: "jim@example.com",
  URL: "https://farm.example" };
// A store holding the toolbar owner's live gate session.
const signed = () => {
  const stores = testStores();

  stores.gate.data.set("allow/jim@example.com", {});
  stores.gate.data.set(`session/${createHash("sha256").update(ID)
    .digest("hex")}`, {
    email: "jim@example.com", expires: Date.now() + 86_400_000,
  });

  return stores;
};
const ask = (path) => new Request(`https://x${path}`, {
  headers: { Cookie: `${COOKIE}=${ID}` },
});

describe("email signatures", () => {
  it("render as inline-styled markup with nothing around it", () => {
    for (const s of library()) {
      assert.doesNotMatch(s.html, /<(html|head|body|style|script)\b/i);
      assert.doesNotMatch(s.html, /\sclass=/);
      assert.match(s.html, /^<table /);
      assert.match(s.html,
        /https:\/\/www\.northfosterfarm\.com\/email-signature\//);
    }
  });

  it("match James's final markup, whitespace aside", () => {
    // His james and jim files carry a stray nested <tr>; the team file
    // does not. One template serves all three, so drop the stray one.
    const squash = (html) => html.replace(/<tr>\s*<tr>/, "<tr>")
      .replace(/\s+/g, " ").replace(/> </g, "><").trim();

    for (const id of ["james", "jim", "team"]) {
      const file = readFileSync(
        new URL(`./fixtures/signatures/${id}.html`, import.meta.url), "utf8",
      );
      const s = library().find((v) => v.id === id);

      assert.equal(squash(s.html), squash(file), id);
    }
  });

  it("have no role, email or phone, and so no gaps", () => {
    for (const s of library()) {
      assert.deepEqual(s.missing, []);
      assert.doesNotMatch(s.html, /\[(role|email|phone)\]|mailto:|tel:/);
    }

    assert.deepEqual(missing(entry("james")), []);
    assert.match(render(entry("jim")).html, /<b>Jim Boynton<\/b>/);
  });

  it("open alone as exactly head, body and the signature", () => {
    assert.equal(alone("<p>x</p>"),
      "<html><head></head><body><p>x</p></body></html>");
  });
});

describe("the signatures routes", () => {
  it("list them and serve one bare page", async () => {
    const list = await handle(ask("/api/staging/signatures"), {
      stores: signed(), env,
    });

    assert.equal(list.status, 200);
    assert.ok((await list.json()).signatures.length > 0);

    const page = await handle(ask("/api/staging/signatures/james"), {
      stores: signed(), env,
    });
    const body = await page.text();

    assert.equal(page.status, 200);
    assert.match(body, /^<html><head><\/head><body><table /);
    assert.match(body, /<\/table><\/body><\/html>$/);

    const none = await handle(ask("/api/staging/signatures/nobody"), {
      stores: signed(), env,
    });

    assert.equal(none.status, 404);
  });

  it("are a 404 in production", async () => {
    const res = await handle(ask("/api/staging/signatures"), {
      stores: signed(),
      env: { CONTEXT: "production", STAGING_TOKEN: "s3cret" },
    });

    assert.equal(res.status, 404);
  });
});
