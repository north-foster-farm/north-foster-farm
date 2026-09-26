import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  listSent, maskEmail, maskText, showSent,
} from "../netlify/functions/lib/sent.mjs";

const KEY = "re_lookup_test";
const env = { RESEND_LOOKUP_KEY: KEY };
const noPause = async () => {};

const email = (id, at, to, subject = `Order ${id}`) => ({
  id, "created_at": at, to: [].concat(to), subject,
  "last_event": "delivered",
  from: "North Foster Farm <farm@mail.northfosterfarm.com>",
  html: "<p>secret body</p>", text: "secret body",
});

// A fake Resend: pages of `per` emails, newest first, by `after`.
const resend = (emails, { per = 2 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);

    if (u.pathname !== "/emails") {
      const one = emails.find((e) => u.pathname === `/emails/${e.id}`);

      return one
        ? new Response(JSON.stringify(one))
        : new Response(JSON.stringify({ message: "Email not found" }),
          { status: 404 });
    }

    const after = u.searchParams.get("after");
    const start = after ? emails.findIndex((e) => e.id === after) + 1 : 0;
    const data = emails.slice(start, start + per);

    return new Response(JSON.stringify({
      object: "list", "has_more": start + per < emails.length, data,
    }));
  };

  return { calls, fetchImpl };
};

const SENT = [
  email("e4", "2026-09-25 10:00:00.1+00", "Pat Smith <pat@example.com>"),
  email("e3", "2026-09-22 10:00:00.1+00", "lee@example.org",
    "Refund needed: NFF-1 cancelled by lee@example.org"),
  email("e2", "2026-09-20 10:00:00.1+00", "pat@example.com"),
  email("e1", "2026-09-18 10:00:00.1+00", "kim@example.net"),
];

describe("maskEmail and maskText", () => {
  it("keeps the first letter and the domain", () => {
    assert.equal(maskEmail("pat@example.com"), "p***@example.com");
    assert.equal(maskEmail("nope"), "***");
  });

  it("masks every address in a subject but the one kept", () => {
    assert.equal(maskText("From lee@example.org to pat@example.com",
      "pat@example.com"), "From l***@example.org to pat@example.com");
  });
});

describe("listSent, what Resend sent", () => {
  it("pages back to --since, newest first, masked", async () => {
    const { calls, fetchImpl } = resend(SENT);
    const rows = await listSent({
      since: "2026-09-19", env, fetchImpl, pause: noPause,
    });

    assert.deepEqual(rows.map((r) => r.id), ["e4", "e3", "e2"]);
    assert.deepEqual(rows[0].to, ["p***@example.com"]);
    assert.equal(rows[1].subject,
      "Refund needed: NFF-1 cancelled by l***@example.org");
    assert.equal(rows[0].at, "2026-09-25T10:00:00.100Z");
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /[?&]after=e3\b/);
  });

  it("names one recipient unmasked with --to", async () => {
    const { fetchImpl } = resend(SENT);
    const rows = await listSent({
      to: "PAT@example.com", env, fetchImpl, pause: noPause,
    });

    assert.deepEqual(rows.map((r) => r.id), ["e4", "e2"]);
    assert.deepEqual(rows[0].to, ["pat@example.com"]);
  });

  it("only GETs, with the lookup key, and never returns a body",
    async () => {
      const { calls, fetchImpl } = resend(SENT);
      const rows = await listSent({ env, fetchImpl, pause: noPause });

      assert.equal(rows.length, 4);
      for (const c of calls) {
        assert.equal(c.init.method, "GET");
        assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
      }
      assert.doesNotMatch(JSON.stringify(rows), /secret body/);
    });

  it("refuses without the key and never calls Resend", async () => {
    const { calls, fetchImpl } = resend(SENT);

    await assert.rejects(listSent({ env: {}, fetchImpl }),
      /RESEND_LOOKUP_KEY is not set/);
    assert.equal(calls.length, 0);
  });

  it("refuses a date it cannot read", async () => {
    await assert.rejects(listSent({ since: "last week", env }),
      /Not a date/);
  });
});

describe("showSent, one email", () => {
  it("gives headers and tags, masked, with no html or text", async () => {
    const { fetchImpl } = resend(SENT);
    const got = await showSent("e3", { env, fetchImpl });

    assert.equal(got.id, "e3");
    assert.deepEqual(got.to, ["l***@example.org"]);
    assert.equal(got.html, undefined);
    assert.equal(got.text, undefined);
    assert.doesNotMatch(JSON.stringify(got), /secret body/);
  });

  it("reports Resend's error without the key", async () => {
    const { fetchImpl } = resend(SENT);
    const error = await showSent("nope", { env, fetchImpl })
      .catch((e) => e);

    assert.match(error.message, /Resend answered 404: Email not found/);
    assert.doesNotMatch(error.message, new RegExp(KEY));
  });
});
