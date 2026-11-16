// A group's short link (#587): /vff answers 302 to the sign-up page
// with the join token in force, read at request time, never cached.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { config, handle } from "../netlify/functions/group-link.mjs";
import {
  GROUPS, joinPath, joinTokenOf, rotateJoinToken,
} from "../netlify/functions/lib/groups.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-11-16T14:00:00Z");

const get = (path, stores, method = "GET") =>
  handle(new Request(`http://x${path}`, { method }), { stores });

const assertJoin = (res, token) => {
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), joinPath(token));
  assert.equal(res.headers.get("Cache-Control"), "no-store");
};

describe("a group's short link", () => {
  it("routes every group key, with and without the slash", () => {
    assert.deepEqual([...config.path].sort(),
      GROUPS.flatMap((g) => [`/${g.key}`, `/${g.key}/`]).sort());
  });

  it("answers /vff and /vff/ with the token in force", async () => {
    const stores = testStores();
    const token = await joinTokenOf(stores, "vff", { now });

    assertJoin(await get("/vff", stores), token);
    assertJoin(await get("/vff/", stores), token);
    assertJoin(await get("/vff", stores, "HEAD"), token);
  });

  it("follows a replaced token", async () => {
    const stores = testStores();
    const old = await joinTokenOf(stores, "vff", { now });
    const { joinToken } = await rotateJoinToken(stores, "vff", { now });

    assert.notEqual(joinToken, old);
    assertJoin(await get("/vff", stores), joinToken);
  });

  it("mints a token for a group with no record yet", async () => {
    const stores = testStores();
    const res = await get("/vff", stores);

    assertJoin(res, await joinTokenOf(stores, "vff"));
    assert.match(res.headers.get("Location"), /^\/join\/\?t=[\w-]{43}$/);
  });

  it("answers 404 to other methods and other paths", async () => {
    const stores = testStores();

    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      assert.equal((await get("/vff", stores, method)).status, 404, method);
    }

    for (const path of ["/", "/vf", "/vffx", "/vff/x", "/join"]) {
      assert.equal((await get(path, stores)).status, 404, path);
    }

    assert.equal(await stores.orders.get("group/vff"), null);
  });
});
