// Where the maintenance bar shows on load (#489): the implementer's
// own tests of noticeOnLoad, beside the criteria tests in
// e2e/maintenance-bar.spec.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noticeOnLoad } from "../assets/scripts/utils/maintenance.js";
import { MESSAGE } from "../netlify/functions/lib/maintenance.mjs";

const closed = { signedIn: false, maintenance: true, message: MESSAGE };

describe("the maintenance bar on load", () => {
  it("shows on the order, account and sign-in pages", () => {
    for (const path of [
      "/order/", "/account/", "/account/orders/NFF-1/", "/login/", "/login",
    ]) {
      assert.equal(noticeOnLoad(closed, path), MESSAGE, path);
    }
  });

  it("stays off every other page", () => {
    for (const path of ["/", "/news/", "/contact/", "/ordering/", ""]) {
      assert.equal(noticeOnLoad(closed, path), "", path);
    }
  });

  it("stays off when /api/me carries no notice", () => {
    // Maintenance off, or an admin's session under maintenance.
    assert.equal(noticeOnLoad({ signedIn: true }, "/order/"), "");
    assert.equal(noticeOnLoad({ signedIn: false }, "/login/"), "");
    assert.equal(noticeOnLoad(null, "/order/"), "");
  });
});
