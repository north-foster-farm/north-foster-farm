import assert from "node:assert/strict";
import { describe, it } from "node:test";

import email from "../data/emails/launch-email.json" with { type: "json" };
import {
  UNSUBSCRIBE_PLACEHOLDER, facts, fill, launchEmail, span,
} from "../netlify/functions/lib/launch.mjs";

// The drop site opens 2026-10-17 (data/delivery.json), at midnight in
// America/New_York, which is 04:00 UTC that day.
const before = new Date("2026-10-17T03:59:59Z");
const opened = new Date("2026-10-17T04:00:00Z");
const drop = "At one of our drop sites: every Saturday morning, "
  + "10:00 to 11:00 AM, at Village Green, 46 Institute Lane, North Scituate";

describe("launch email", () => {
  it("fills every fact from data/", () => {
    const { body } = launchEmail(before);
    assert.doesNotMatch(body, /[{}]/);
    for (const line of [
      "- Every Thursday, between 10:00 AM and 4:00 PM",
      "Order by noon on Wednesday",
      "$40 minimum, $5 fee",
      "99 East Killingly Road, Foster, RI 02825",
      "PICKUP DAYS\n- At one of our drop sites: every Saturday",
      "Markets and pop-ups we open for pickup show up on the order",
      `Unsubscribe in one click: ${UNSUBSCRIBE_PLACEHOLDER}`,
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

  it("takes each reader's unsubscribe link from the send", () => {
    const url = "https://www.northfosterfarm.com/news/?unsubscribe=t0k3n";
    const { body } = launchEmail(opened, { unsubscribeUrl: url });
    assert.ok(body.includes(`Unsubscribe in one click: ${url}`));
    assert.ok(!body.includes(UNSUBSCRIBE_PLACEHOLDER));
  });

  it("asks nobody to opt in again", () => {
    assert.doesNotMatch(email.body, /Sign up button|within \{inviteLife\}/);
    assert.doesNotMatch(email.body, /won't hear from us again/);
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
