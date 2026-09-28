import assert from "node:assert/strict";
import { describe, it } from "node:test";

import email from "../data/emails/launch-email.json" with { type: "json" };
import {
  FACTS, fill, launchEmail, span,
} from "../netlify/functions/lib/launch.mjs";

describe("launch email", () => {
  it("fills every fact from data/", () => {
    const { body } = launchEmail();
    assert.doesNotMatch(body, /[{}]/);
    for (const line of [
      "We deliver every week on Thursday, between 10:00 AM and 4:00 PM",
      "Order by noon on Wednesday",
      "$40 minimum, $5 fee, free on orders of $150 or more",
      "99 East Killingly Road, Foster, RI 02825",
      "Back on Saturday mornings in Scituate, 10:00 to 11:00 AM, " +
        "starting October 17",
      "Village Green, 46 Institute Lane, North Scituate, in the same",
      "from $5 off orders of $50 up to $20 off orders of $200",
      "Click it within a week and you're on the new list",
    ]) assert.ok(body.includes(line), line);
  });

  it("keeps the facts out of the words", () => {
    assert.doesNotMatch(email.body,
      /\$\d|Thursday|Institute Lane|Killingly|a week/);
  });

  it("words the invite's life in days unless it is a week", () => {
    assert.equal(span(7), "a week");
    assert.equal(span(10), "10 days");
  });

  it("follows the data when it changes", () => {
    const facts = { ...FACTS, deliveryDay: "Friday" };
    assert.equal(fill("on {deliveryDay}", facts), "on Friday");
  });

  it("refuses an unknown token", () => {
    assert.throws(() => fill("{nope}"), /unknown \{nope\}/);
  });
});
