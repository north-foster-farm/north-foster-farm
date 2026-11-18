// #626 takes the "Deliver to <group>" option off the order page, but
// production may hold orders placed with it (#471). Criterion 3 of
// #626: such an order still displays, emails and edits as before. The
// stored order comes from group-delivery-stored.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicOrder } from "../netlify/functions/lib/account.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import {
  EMAIL, GYM, SKU, atPlace, editStored, now, storedToGroup,
} from "./group-delivery-stored.mjs";

describe("an order placed with the group delivery option (#626)", () => {
  it("still displays, emails and edits as before", async () => {
    const { stores, id } = await storedToGroup();

    // Displays: the account's view of it is a delivery to the place.
    const shown = publicOrder(await getOrder(stores, id), now);

    assert.equal(shown.fulfilment.method, "delivery");
    atPlace(shown.fulfilment.delivery);

    // Edits: one more chicken, the delivery untouched, goes through
    // and leaves the delivery to the place as it was.
    const sent = [];
    const mail = async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    };
    const result = await editStored(stores, id, {
      idempotencyKey: "edit-key-000000-626",
      lines: [{ sku: SKU, qty: 3 }],
      payment: { method: "card", sourceId: "cnon:tok" },
    }, mail);

    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const saved = await getOrder(stores, id);

    assert.equal(saved.fulfilment.method, "delivery");
    assert.equal(saved.fulfilment.date, "2026-11-05");
    atPlace(saved.fulfilment.delivery);
    assert.equal(saved.fulfilment.delivery.toGroup, true,
      "the stored record keeps its shape");
    assert.equal(saved.lines.find((l) => l.sku === SKU).qty, 3);
    assert.deepEqual(saved.group && saved.group.key, "vff");

    // Emails: the customer is told of the change, with the place's
    // address as the delivery's.
    const theirs = sent.filter((m) => m.to === EMAIL);

    assert.ok(theirs.length >= 1, "the customer is emailed");
    assert.ok(theirs.some((m) => `${m.text || ""}${m.html || ""}`
      .includes(GYM.street)), "the email names the place's address");
  });
});
