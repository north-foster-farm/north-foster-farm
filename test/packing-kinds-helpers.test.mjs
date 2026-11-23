// The implementer's own tests for #694's revision (one packing email
// per kind of fulfillment), for what the criteria tests in
// test/packing-kinds.test.mjs do not reach: which kind each way of
// getting an order is, a pop-up whose name already says so, and a
// 3 PM packet still owed at 6 AM, which is never sent from then on and
// prints no order twice (James and qa on PR #701). Every order is a fake
// from the staging library; no mail leaves the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PACKING_KINDS, packingGroup, packingKind,
} from "../netlify/functions/lib/describe.mjs";
import {
  dropSite, order as delivery, pickup, popUp,
} from "../netlify/functions/lib/library.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { PENDING, PING_KEY } from "../netlify/functions/lib/packing.mjs";
import {
  amendOrder, saveOrder, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);
const FRI = "2026-11-20";
const SAT = "2026-11-21";
const placed = at("2026-11-19", 9);

const occurrence = (code, date) => ({
  method: "scheduled", occurrence: `${code}-${date.slice(2)
    .replaceAll("-", "")}`, date, onfarm: null, delivery: null,
});

const fake = (id, build, fulfilment) => build({
  id, submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
  emails: { orderConfirmed: { at: placed.toISOString() } },
  lines: [{ sku: `SKU-${id}`, label: "Eggs", qty: 2, lineTotal: 14 }],
  fulfilment,
});

const pdfOf = (m) => Buffer.from(m.attachments[0].content, "base64")
  .toString("latin1");

describe("the kinds of fulfillment (#694, James's revision)", () => {
  it("puts the drop site, markets and pop-ups in one kind", () => {
    assert.equal(packingKind(dropSite().fulfilment), PACKING_KINDS.market);
    assert.equal(packingKind(popUp().fulfilment), PACKING_KINDS.market);
    assert.equal(packingKind(occurrence("H3TQ", SAT)), PACKING_KINDS.market);
    assert.equal(packingKind(pickup().fulfilment), PACKING_KINDS.onfarm);
    assert.equal(packingKind(delivery().fulfilment), PACKING_KINDS.delivery);
  });

  it("never names a pop-up \"pop-up\" twice", () => {
    assert.equal(packingGroup(occurrence("VZF5", "2026-10-18")).place,
      "Pop-up at The Village Family Fitness");
  });
});

describe("a 3 PM packet still owed at 6 AM (#694)", () => {
  // Three drop site orders for Saturday. The 3 PM send fails; Friday
  // evening one order changes and one is canceled. `down(m, now)` says
  // which sends fail at each run. Every 15-minute run from 3 PM Friday
  // through 7 AM Saturday. -> the packing emails that went, and the
  // packing check's pings.
  const ids = ["NFF-2611-DSO1", "NFF-2611-DSO2", "NFF-2611-DSO3"];
  const URL = "https://hc-ping.example/packing-check";
  const day = async (down) => {
    const stores = testStores();
    const sent = [];
    const pings = [];
    let now = null;
    const mail = async (m) => {
      if (down(m, now)) throw new Error("Resend 503");
      sent.push(m);

      return { id: `m${sent.length}` };
    };
    const fetchImpl = async (url) => {
      if (String(url).startsWith(URL)) pings.push({ url, now });

      return new Response("OK");
    };

    for (const id of ids) {
      await saveOrder(stores, fake(id, dropSite, occurrence("VFVQ", SAT)),
        placed);
    }
    for (let t = at(FRI, 15).getTime(); t <= at(SAT, 7).getTime();
      t += 15 * 60 * 1000) {
      now = new Date(t);
      if (t === at(FRI, 20).getTime()) {
        await amendOrder(stores, ids[0], { notes: "Ring twice" }, "edited",
          now);
      }
      if (t === at(FRI, 21).getTime()) {
        await setStatus(stores, ids[2], "cancelled", now);
      }
      await runJobs(stores, {
        env: {
          FARM_NOTIFICATIONS_EMAIL: "farm@example.com", MAIL_DRIVER: "resend",
          [PING_KEY]: URL,
        },
        mail, now, fetchImpl,
      });
    }

    return {
      stores, pings, mails: sent.filter((m) => /^Packing slips/
        .test(m.subject)),
    };
  };
  const eve = (m) => /^Packing slips: /.test(m.subject);
  const before = (now, h, min = 0) => now.getTime() < at(SAT, h, min)
    .getTime();
  const holding = (mails, id) => mails.filter((m) => m.text.includes(id))
    .map((m) => m.subject);

  // No order is in two emails.
  const printedOnce = ({ mails }) => {
    for (const id of ids) {
      assert.ok(holding(mails, id).length <= 1,
        `${id} is printed once: ${holding(mails, id).join(" | ")}`);
    }
  };

  // The 3 PM packet never goes from 6 AM on (James, 2026-11-21): the
  // 6 AM run sends only what is late against it and pings /fail.
  const neverAfterSix = async ({ stores, mails, pings }) => {
    const late = mails.filter((m) => !eve(m));

    assert.deepEqual(mails.filter(eve), [], "no 3 PM copy goes");
    assert.equal(late.length, 1);
    assert.match(late[0].text, /NFF-2611-DSO1\) \(changed\)/);
    assert.match(late[0].text, /NFF-2611-DSO3\) \(canceled\)/);
    assert.ok(!late[0].text.includes(ids[1]), "no catch-up");
    assert.match(pdfOf(late[0]), /\(REVISED\)/);
    assert.ok(pings.some((p) => p.url === `${URL}/fail`
      && p.now.getTime() >= at(SAT, 6).getTime()),
    "the 6 AM run pings /fail");
    assert.equal(await stores.jobs.get(`${PENDING}${SAT}`), null,
      "the 6 AM packet is not owed");
  };

  it("never sends the 3 PM copy from 6 AM on, and pings /fail",
    async () => {
      const got = await day((m) => eve(m));

      await neverAfterSix(got);
      printedOnce(got);
    });

  // The case qa found on PR #701: all mail down at 6 AM, back at 6:15.
  it("prints no order twice when all mail is down at 6 AM", async () => {
    const got = await day((m, now) => eve(m) || before(now, 6, 15));

    await neverAfterSix(got);
    printedOnce(got);
  });

  // The retry goes before 6 AM: the 6 AM run sends only the changes.
  it("prints no order twice when the retry goes before 6 AM",
    async () => {
      const got = await day((m, now) => eve(m) && before(now, 5, 45));
      const three = got.mails.filter(eve);

      assert.equal(three.length, 1);
      assert.equal(holding(got.mails, ids[1]).length, 1,
        "the unchanged slip goes in the retry");
      assert.ok(got.pings.every((p) => p.url !== `${URL}/fail`
        || p.now.getTime() < at(SAT, 6).getTime()), "6 AM is healthy");
      printedOnce(got);
    });
});
