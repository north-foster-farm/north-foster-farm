// #947's criteria: the account page takes a link's order value as an
// order id only when it has the shape of one (the site's order id
// pattern, as #937 corrects it: NFF-, four digits, a dash and six
// letters and digits, or four for the ids before #253). Anything else
// is ignored as if the link carried no order, so the not-found line
// never echoes text the farm did not write.
//
// Written by the test agent from the issue's words, before the fix
// (#730, #896). Held out of the suite as .criteria.mjs; the implementer
// renames it to order-link-shape.test.mjs.
//
// - box 1: a value not in the shape of an order id reads as no order,
//   so none of its text can reach the page (the page's own text is
//   checked in e2e/order-link-shape.spec.mjs);
// - box 2: a well-formed id still reads as that id, so the page still
//   names it when no order matches (a guard: it passes today, and the
//   page's line is checked in the spec and in
//   e2e/account-orders-pinned.spec.mjs);
// - box 3: a malformed escape in the path form does not throw and reads
//   as no order;
// - box 4, the staging redirect, is in e2e/order-link-shape.spec.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { orderFromLink } from "../assets/scripts/account/lib/order-link.mjs";

const at = (href) => {
  const url = new URL(href, "https://example.test");

  return orderFromLink({ pathname: url.pathname, search: url.search });
};

// Values a crafted link could carry, none in the shape of an order id.
const NOT_IDS = [
  "Call 555-0100 to confirm your order",
  "NFF 2611",
  "<b>NFF-2611-ABCDEF</b>",
  "NFF-2611-ABCDEF now call 555-0100",
  "NFF-2611-ABCDE",
  "NFF-2611-ABCDEFG",
  "NFF-2611-ABC",
  "NFF-26-ABCDEF",
  "XYZ-2611-ABCDEF",
  "NFF-2611-ABCD-EF",
];

// Ids of both lengths the pattern allows.
const IDS = ["NFF-2611-K3WMPA", "NFF-2610-K3WM", "NFF-2611-ZZZZZZ"];

describe("an order link's value and the shape of an order id (#947)", () => {
  it("A link whose order value is not in the shape of an order id opens "
    + "the account page as if it carried no order, and none of its text "
    + "appears on the page", () => {
    for (const value of NOT_IDS) {
      const query = `/account/?order=${encodeURIComponent(value)}`;
      const path = `/account/orders/${encodeURIComponent(value)}/`;

      assert.equal(at(query), "", `the query form: ${value}`);
      assert.equal(at(`${query}/`), "", `the query form, slashed: ${value}`);
      assert.equal(at(path), "", `the path form: ${value}`);
    }
    // A malformed escape in the query reads as no order too.
    assert.equal(at("/account/?order=%E0%A4%A"), "");
  });

  it("A link with a well-formed id that matches no order of the session "
    + "still says the order could not be found, naming that id", () => {
    for (const id of IDS) {
      assert.equal(at(`/account/?order=${id}`), id, `the query form: ${id}`);
      assert.equal(at(`/account/?order=${id}/`), id, `the splat: ${id}`);
      assert.equal(at(`/account/?order=${id}/&email=changed`), id,
        `beside another query: ${id}`);
      assert.equal(at(`/account/orders/${id}/`), id, `the path form: ${id}`);
      assert.equal(at(`/account/orders/${id}`), id, `no slash: ${id}`);
    }
  });

  it("A malformed escape in the path form does not throw; the page opens "
    + "as if the link carried no order", () => {
    for (const path of [
      "/account/orders/%E0%A4%A/",
      "/account/orders/NFF-2611-ABCDEF%/",
      "/account/orders/%/",
      "/account/orders/%ZZ",
    ]) {
      assert.doesNotThrow(() => at(path), path);
      assert.equal(at(path), "", path);
    }
  });
});
