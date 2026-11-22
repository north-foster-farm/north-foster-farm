// The address rule for input (receivedEmail) and bin/nff's address
// arguments (#758): an address is decoded once, cleaned and checked
// before anything uses it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { receivedEmail } from "../assets/scripts/utils/email.js";
import { addressArgs } from "../bin/address-args.mjs";

describe("receivedEmail", () => {
  it("decodes once, trims and lowercases", () => {
    assert.equal(receivedEmail("pat%2Bdog%40example.com"),
      "pat+dog@example.com");
    assert.equal(receivedEmail("  Pat+Dog@Example.COM "),
      "pat+dog@example.com");
    assert.equal(receivedEmail("pat+dog@example.com"), "pat+dog@example.com");
  });

  it("refuses what is not one clean address", () => {
    for (const value of [
      "pat%252Bdog%2540example.com", "a%2540b@example.com",
      "pat\u0007dog@example.com", "pat\u0085dog@example.com",
      "pat%07dog@example.com", "pat%zzdog@example.com", "not an address",
      "pat dog@example.com", "", null, undefined, 5, ["a@example.com"],
    ]) {
      assert.equal(receivedEmail(value), null, JSON.stringify(value));
    }
  });
});

describe("addressArgs", () => {
  it("hands each address on in its checked form", () => {
    const got = addressArgs("customers", "rename",
      ["Pat%40Example.com", "sam@example.com", "--x"], { email: "A@b.co" });

    assert.deepEqual(got.rest,
      ["pat@example.com", "sam@example.com", "--x"]);
    assert.equal(got.flags.email, "a@b.co");
    assert.equal(addressArgs("login", "Pat%40example.com", [], {}).action,
      "pat@example.com");
  });

  it("leaves other arguments and a missing address alone", () => {
    assert.deepEqual(addressArgs("perks", "list", [], {}).rest, []);
    assert.deepEqual(
      addressArgs("perks", "add", ["pat@example.com", "free-delivery"], {})
        .rest,
      ["pat@example.com", "free-delivery"],
    );
    assert.deepEqual(addressArgs("orders", "show", ["NFF-1%"], {}).rest,
      ["NFF-1%"]);
  });

  it("refuses a bad address with an error naming it", () => {
    assert.throws(
      () => addressArgs("customers", "show", ["member%2540james.com"], {}),
      /Not a valid email address: "member%2540james.com"/,
    );
    assert.throws(
      () => addressArgs("groups", "remove", ["k", "x at y"], {}),
      /Not a valid email address/,
    );
    assert.throws(() => addressArgs("orders", "list", [], { email: "x" }),
      /Not a valid email address/);
  });
});
