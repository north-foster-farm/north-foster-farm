// The staging toolbar's Packing slips section (#334). Every order is
// fake.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { COOKIE } from "../netlify/functions/lib/gate.mjs";
import { order } from "../netlify/functions/lib/library.mjs";
import { build, has, pages } from "../netlify/functions/lib/slips.mjs";
import { saveOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/staging.mjs";

const ID = "owner-session-id-0123456789abcdef";
const env = { CONTEXT: "branch-deploy", GATE_TOOLBAR_EMAIL: "jim@example.com" };
const signed = () => {
  const stores = testStores();

  stores.gate.data.set("allow/jim@example.com", {});
  stores.gate.data.set(`session/${createHash("sha256").update(ID)
    .digest("hex")}`, {
    email: "jim@example.com", expires: Date.now() + 86_400_000,
  });

  return stores;
};
const ask = (path, headers = { Cookie: `${COOKIE}=${ID}` }) =>
  new Request(`https://x${path}`, { headers });
const TODAY = "/api/staging/slips/today?date=";
const text = (bytes) => Buffer.from(bytes).toString("latin1");

describe("the packing slip fixtures", () => {
  it("list every page type the packet can hold", () => {
    assert.deepEqual(pages().map((p) => p.id), [
      "cover", "card", "venmo", "wallet", "part", "refunded",
      "unpaid-pickup", "unpaid-delivery", "revision", "cancelled",
    ]);
  });

  it("each build a PDF, the same every time", () => {
    for (const { id } of pages()) {
      const bytes = build(id);

      assert.equal(text(bytes).slice(0, 5), "%PDF-", id);
      assert.deepEqual(build(id), bytes, id);
    }
    assert.equal(build("nope"), null);
    assert.equal(has("card"), true);
  });

  it("show what each page type is about", () => {
    assert.match(text(build("card")), /Visa \*4242/);
    assert.match(text(build("venmo")), /Venmo/);
    assert.match(text(build("wallet")), /Apple Pay/);
    assert.doesNotMatch(text(build("card")), /Amount due/);
    for (const id of ["part", "unpaid-pickup", "unpaid-delivery"]) {
      assert.match(text(build(id)), /Amount due/, id);
    }
    assert.match(text(build("unpaid-pickup")), /cash/);
    assert.match(text(build("cancelled")), /CANCELLED/i);
  });
});

describe("the packing slip routes", () => {
  it("list the pages and serve each as a PDF", async () => {
    const list = await handle(ask("/api/staging/slips"), {
      stores: signed(), env,
    });
    const body = await list.json();

    assert.equal(list.status, 200);
    assert.equal(body.slips.length, 10);
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);

    const page = await handle(ask("/api/staging/slips/card"), {
      stores: signed(), env,
    });

    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "application/pdf");
    assert.equal(text(await page.arrayBuffer()).slice(0, 5), "%PDF-");

    const none = await handle(ask("/api/staging/slips/nobody"), {
      stores: signed(), env,
    });

    assert.equal(none.status, 404);
  });

  it("build today's packet from staging's orders and change nothing",
    async () => {
      const stores = signed();
      const before = [...stores.jobs.data.keys()];

      await saveOrder(stores, order({ id: "NFF-2610-TEST" }));

      const res = await handle(ask(`${TODAY}2026-10-06`), {
        stores, env,
      });

      assert.equal(res.status, 200);
      assert.match(text(await res.arrayBuffer()), /NFF-2610-TEST/);
      assert.deepEqual([...stores.jobs.data.keys()], before);

      const empty = await handle(ask(`${TODAY}2026-10-09`), {
        stores, env,
      });

      assert.equal(empty.status, 404);

      const bad = await handle(ask(`${TODAY}soon`), {
        stores, env,
      });

      assert.equal(bad.status, 400);
    });

  it("are a 404 in production and a 401 without a session", async () => {
    const prod = await handle(ask("/api/staging/slips"), {
      stores: signed(),
      env: { CONTEXT: "production", STAGING_TOKEN: "s3cret" },
    });

    assert.equal(prod.status, 404);

    const anon = await handle(ask("/api/staging/slips", {}), {
      stores: signed(), env,
    });

    assert.equal(anon.status, 401);
  });

  it("refuse the machine token, which opens no toolbar area", async () => {
    const res = await handle(ask("/api/staging/slips", {
      Authorization: "Bearer s3cret",
    }), {
      stores: signed(), env: { ...env, STAGING_TOKEN: "s3cret" },
    });

    assert.ok([401, 403].includes(res.status), res.status);
  });
});
