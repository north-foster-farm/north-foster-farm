import assert from "node:assert/strict";
import { describe, it } from "node:test";

import email from "../data/emails/launch-email.json" with { type: "json" };
import {
  facts, fill, launchEmail, span,
} from "../netlify/functions/lib/launch.mjs";

// The drop site opens 2026-10-17 (data/delivery.json), at midnight in
// America/New_York, which is 04:00 UTC that day.
const before = new Date("2026-10-17T03:59:59Z");
const opened = new Date("2026-10-17T04:00:00Z");
const drop = "At the drop site: back on Saturday mornings in Scituate, "
  + "10:00 to 11:00 AM";

describe("launch email", () => {
  it("fills every fact from data/", () => {
    const { body } = launchEmail(before);
    assert.doesNotMatch(body, /[{}]/);
    for (const line of [
      "We deliver every week on Thursday, between 10:00 AM and 4:00 PM",
      "Order by noon on Wednesday",
      "$40 minimum, $5 fee, free on orders of $150 or more",
      "99 East Killingly Road, Foster, RI 02825",
      "back on Saturday mornings in Scituate, 10:00 to 11:00 AM, " +
        "starting October 17",
      "Village Green, 46 Institute Lane, North Scituate, in the same",
      "from $5 off orders of $50 up to $20 off orders of $200",
      "SCHEDULED PICKUP\n- At the drop site: back on Saturday",
      "Markets and pop-ups we open for pickup show up on the order",
      "Click it within a week and you're on the new list",
    ]) assert.ok(body.includes(line), line);
  });

  it("names the drop site's first day while it is ahead", () => {
    assert.ok(launchEmail(before).body.includes(
      `- ${drop}, starting October 17\n`));
  });

  it("drops the first day once the drop site opens", () => {
    for (const now of [opened, new Date("2026-11-01T15:00:00Z")]) {
      const { body } = launchEmail(now);
      assert.ok(body.includes(`- ${drop}\n`));
      assert.doesNotMatch(body, /starting/);
    }
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
    const values = { ...facts(before), deliveryDay: "Friday" };
    assert.equal(fill("on {deliveryDay}", values), "on Friday");
  });

  it("refuses an unknown token", () => {
    assert.throws(() => fill("{nope}"), /unknown \{nope\}/);
  });
});
