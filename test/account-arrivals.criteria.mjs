// Criteria tests for #841, phase 9 of the split of account/main.js
// (docs/refactors/account.md, "Phase 9: tabs and arrivals"), held out
// of `npm test` until the phase lands.
//
// Turn it on, in the commit that moves the code:
//   git mv test/account-arrivals.criteria.mjs test/account-arrivals.test.mjs
//
// All three criteria are of the new-module kind: they fail on `next`,
// where account/lib/arrivals.mjs's tabOf, withoutParams and loginUrl
// do not exist, and pass once the phase draws the redirects' URLs out.
// Nothing retires.
//
// Contract (the design names the functions and their module, not
// their arguments; these are the test agent's choice; the call shape
// may be adapted, the expected values may not):
//
//   tabOf(hash, known)  hash: location.hash; known: the tabs' names
//   withoutParams(search, names)  -> the query, "?..." or ""
//   loginUrl({ pathname, search, hash, confirm })
//     confirm  the email-change link waiting ({ token, email }), or
//              null

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  loginUrl, tabOf, withoutParams,
} from "../assets/scripts/account/lib/arrivals.mjs";
import { assertPure } from "./pure-module.mjs";

const TABS = ["orders", "receipts", "membership", "address", "settings",
  "help"];

// Box 1 of #841.
describe("tabOf", () => {
  it("gives the tab a hash names, and Orders for an unknown or empty "
    + "one", () => {
    assert.equal(tabOf("#settings", TABS), "settings");
    assert.equal(tabOf("#help", TABS), "help");
    for (const hash of ["", "#", "#nope", "#confirm=abc"]) {
      assert.equal(tabOf(hash, TABS), "orders", JSON.stringify(hash));
    }
    assert.equal(tabOf("#membership", TABS.filter((t) => t !== "membership")),
      "orders", "a tab the page has removed");
  });
});

// Box 2 of #841.
describe("withoutParams", () => {
  it("drops the named parameters and keeps the rest, with no question mark "
    + "when none is left", () => {
    assert.equal(withoutParams("?joined=1&via=qr&x=2", ["joined", "via"]),
      "?x=2");
    assert.equal(withoutParams("?joined=1&via=qr", ["joined", "via"]), "");
    assert.equal(withoutParams("?email=changed", ["email"]), "");
    assert.equal(withoutParams("", ["joined"]), "");
    assert.equal(withoutParams("?a=1&b=two%20words", ["joined"]),
      "?a=1&b=two+words");
  });
});

// Box 3 of #841.
describe("loginUrl", () => {
  it("carries the path, query and hash to come back to, or the confirm "
    + "fragment when an email-change link is waiting", () => {
    assert.equal(loginUrl({ pathname: "/account/orders/NFF-1/", search: "",
      hash: "", confirm: null }),
    `/login/?next=${encodeURIComponent("/account/orders/NFF-1/")}`);
    assert.equal(loginUrl({ pathname: "/account/", search: "?joined=1",
      hash: "#membership", confirm: null }),
    `/login/?next=${encodeURIComponent("/account/?joined=1#membership")}`);
    assert.equal(loginUrl({ pathname: "/account/", search: "", hash: "",
      confirm: { token: "t/k+n", email: "new@example.com" } }),
    `/login/#confirm=${encodeURIComponent("t/k+n")}&email=${
      encodeURIComponent("new@example.com")}`);
  });
});

describe("design, section 2", () => {
  it("keeps account/lib/arrivals.mjs pure", () => {
    assertPure(new URL("../assets/scripts/account/lib/arrivals.mjs",
      import.meta.url), { banned: ["document", "(?<![.\\w])window\\.",
      "location\\.", "history\\.", "Element"] });
  });
});
