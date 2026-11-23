// The order an email's link names (#924), read by the account page
// from where netlify.toml's redirect leaves it, or off the old path.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { orderFromLink } from "../assets/scripts/account/lib/order-link.mjs";

const at = (href) => {
  const url = new URL(href, "https://example.test");

  return orderFromLink({ pathname: url.pathname, search: url.search });
};

describe("orderFromLink", () => {
  it("reads the id the redirect puts in the query", () => {
    assert.equal(at("/account/?order=NFF-2611-ABCDEF"), "NFF-2611-ABCDEF");
  });

  it("drops the slash the redirect's splat carries", () => {
    assert.equal(at("/account/?order=NFF-2611-ABCDEF/"), "NFF-2611-ABCDEF");
  });

  it("keeps the id beside another query", () => {
    assert.equal(at("/account/?order=NFF-2611-ABCDEF/&email=changed"),
      "NFF-2611-ABCDEF");
  });

  it("finds the id when a redirect joins a second query badly", () => {
    assert.equal(at("/account/?order=NFF-2611-ABCDEF/?utm=mail"),
      "NFF-2611-ABCDEF");
  });

  it("still reads the id off the path where no rule runs", () => {
    assert.equal(at("/account/orders/NFF-2611-ABCDEF/"), "NFF-2611-ABCDEF");
  });

  it("reads text not in the shape of an order id as no order (#947)", () => {
    assert.equal(at("/account/orders/NFF%202611/"), "");
  });

  it("names no order on the plain account page", () => {
    assert.equal(at("/account/"), "");
    assert.equal(at("/account/?order="), "");
  });
});
