import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  alone, library, missing, render, entry,
} from "../netlify/functions/lib/signatures.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/staging.mjs";

const env = { CONTEXT: "branch-deploy", STAGING_TOKEN: "s3cret",
  URL: "https://farm.example" };
const ask = (path) => new Request(`https://x${path}`, {
  headers: { Authorization: "Bearer s3cret" },
});

describe("email signatures", () => {
  it("render as inline-styled markup with nothing around it", () => {
    for (const s of library(env)) {
      assert.doesNotMatch(s.html, /<(html|head|body|style|script)\b/i);
      assert.doesNotMatch(s.html, /\sclass=/);
      assert.match(s.html, /^<table /);
      assert.match(s.html, /https:\/\/farm\.example\/email-signature\//);
    }
  });

  it("show a gap, never an invented detail, for what is missing", () => {
    const s = library(env).find((v) => v.id === "james");

    assert.deepEqual(s.missing, ["role", "email", "phone"]);
    assert.match(s.html, /\[role\]/);
    assert.match(s.text, /\[phone\]/);
  });

  it("fill an address and a phone from the farm's own data", () => {
    const v = { ...entry("james"), email: "sales", phone: "company" };

    assert.deepEqual(missing({ ...v, role: "Farmer" }), []);
    assert.match(render(v, env).html, /mailto:sales@/);
    assert.match(render(v, env).html, /tel:\+1/);
  });

  it("open alone as exactly head, body and the signature", () => {
    assert.equal(alone("<p>x</p>"),
      "<html><head></head><body><p>x</p></body></html>");
  });
});

describe("the signatures routes", () => {
  it("list them and serve one bare page", async () => {
    const list = await handle(ask("/api/staging/signatures"), {
      stores: testStores(), env,
    });

    assert.equal(list.status, 200);
    assert.ok((await list.json()).signatures.length > 0);

    const page = await handle(ask("/api/staging/signatures/james"), {
      stores: testStores(), env,
    });
    const body = await page.text();

    assert.equal(page.status, 200);
    assert.match(body, /^<html><head><\/head><body><table /);
    assert.match(body, /<\/table><\/body><\/html>$/);

    const none = await handle(ask("/api/staging/signatures/nobody"), {
      stores: testStores(), env,
    });

    assert.equal(none.status, 404);
  });

  it("are a 404 in production", async () => {
    const res = await handle(ask("/api/staging/signatures"), {
      stores: testStores(),
      env: { CONTEXT: "production", STAGING_TOKEN: "s3cret" },
    });

    assert.equal(res.status, 404);
  });
});
