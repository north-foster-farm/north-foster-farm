// Criteria tests for #694 (packing slips just in time, one email per
// fulfillment group), written 2026-11-20 from its "Done when" boxes
// before any code. One test per box, named for it; the last box
// (reviews and James's approval) is not a test. Held out of `npm test`
// by its name until the implementer turns it on with
//
//   git mv test/packing-groups.criteria.mjs test/packing-groups.test.mjs
//
// James's two subjects are pinned word for word. The other subjects
// are drafts, so only their form is tested: `{place} packing slips
// for {Weekday} {M/D}`, and a late marker. Every order is a fake from
// the staging library; no mail leaves the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import locations from "../data/locations.json" with { type: "json" };
import series from "../data/series.json" with { type: "json" };
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  dropSite, order as delivery, pickup, popUp,
} from "../netlify/functions/lib/library.mjs";
import {
  PING_KEY, changesBetween, packingDaily, packingEve, readPrinted,
  snapshotOf,
} from "../netlify/functions/lib/packing.mjs";
import {
  amendOrder, getOrder, saveOrder, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

// Friday 20 November 2026 and the days around it.
const THU = "2026-11-19";
const FRI = "2026-11-20";
const SAT = "2026-11-21";
const SUN = "2026-11-22";
const MON = "2026-11-23";
const TUE = "2026-11-24";
const WED = "2026-11-25";
const NEXT_SAT = "2026-11-28";
const placed = at(THU, 9);

const URL = "https://hc-ping.example/packing-check";
const FARM = {
  FARM_NOTIFICATIONS_EMAIL: "farm@example.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
};
// Production, sending for real, with the check configured.
const LIVE = { ...FARM, MAIL_DRIVER: "resend", [PING_KEY]: URL };

// The places, from the site's data.
const seriesNamed = (pred) => series.series.find(pred);
const DROP = seriesNamed((s) => s.kind === "drop-site");
const PREP = seriesNamed((s) => s.name === "Thanksgiving Prep");
const MARKET = seriesNamed((s) => s.name === "Pawtucket Farmers Market");
const townOf = (s) => locations.locations
  .find((l) => l.code === s.location).town;

const occurrence = (s, date) => ({
  method: "scheduled", occurrence: `${s.code}-${date.slice(2)
    .replaceAll("-", "")}`, date, onfarm: null, delivery: null,
});

// A fake order from the library's builders: `id`, its fulfillment and
// one line whose label names its group, so a pick list shows whose
// items it holds.
const fake = (id, build, fulfilment, item) => build({
  id, submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
  emails: { orderConfirmed: { at: placed.toISOString() } },
  lines: [{ sku: `SKU-${id}`, label: item, qty: 2, lineTotal: 14 }],
  fulfilment,
});

const atDrop = (id, date = SAT, item = "Drop site eggs") =>
  fake(id, dropSite, occurrence(DROP, date), item);
const atPrep = (id, item = "Prep turkey") =>
  fake(id, popUp, occurrence(PREP, SAT), item);
const atMarket = (id, date = TUE, item = "Market sausage") =>
  fake(id, popUp, occurrence(MARKET, date), item);
const onFarm = (id, date = SAT, item = "Farm stand chicken") =>
  fake(id, pickup, { ...pickup().fulfilment, date }, item);
const delivered = (id, date = WED, item = "Delivered ham") =>
  fake(id, delivery, { ...delivery().fulfilment, date }, item);

const harness = ({ failWhen = null } = {}) => {
  const sent = [];
  const pings = [];

  return {
    sent, pings,
    mail: async (m) => {
      if (failWhen && failWhen(m)) throw new Error("Resend 503");
      sent.push(m);

      return { id: `m${sent.length}` };
    },
    fetchImpl: async (url, init = {}) => {
      pings.push({ url, method: init.method || "GET" });

      return new Response("OK", { status: 200 });
    },
  };
};

// The packing emails among everything a run sends: the slips, the
// late slips and the "no packing slips" email.
const isPacking = (m) => /packing slips/i.test(m.subject);

// One 15-minute run of the real job. -> the packing emails it sent.
const tick = async (stores, h, now, env = FARM) => {
  const from = h.sent.length;

  await runJobs(stores, { env, mail: h.mail, fetchImpl: h.fetchImpl, now });

  return h.sent.slice(from).filter(isPacking);
};

const save = (stores, orders, when = placed) => Promise.all(
  orders.map((o) => saveOrder(stores, o, when)));

// An email's one PDF, as text; "" when it has none.
const pdfOf = (m) => {
  assert.ok((m.attachments || []).length <= 1,
    `"${m.subject}" has one PDF at most`);

  return m.attachments && m.attachments.length
    ? Buffer.from(m.attachments[0].content, "base64").toString("latin1")
    : "";
};

const everything = (m) => `${m.subject}\n${m.text}\n${pdfOf(m)}`;

// The ids of `ids` an email's PDF holds, sorted.
const idsIn = (m, ids) => ids.filter((id) => pdfOf(m).includes(id)).sort();

// Each email's PDF holds exactly one group's orders, and each group
// has exactly one email. `groups` maps a name to its ids.
const oneEmailPerGroup = (mails, groups) => {
  const all = Object.values(groups).flat();
  const seen = mails.map((m) => idsIn(m, all).join(","));
  const want = Object.values(groups).map((g) => [...g].sort().join(","));

  assert.deepEqual([...seen].sort(), [...want].sort(),
    `one email per group: ${mails.map((m) => m.subject).join(" | ")}`);
};

const mailHolding = (mails, id) => mails.find((m) => pdfOf(m).includes(id));

const WEEKDAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const FORM = new RegExp(`^(.+) packing slips for (${WEEKDAYS}) ` +
  "(\\d{1,2})/(\\d{1,2})$");

// `{place} packing slips for {Weekday} {M/D}`. -> the place.
const assertForm = (subject, weekday, md) => {
  const m = FORM.exec(subject);

  assert.ok(m, `"${subject}" reads {place} packing slips for {Weekday} ` +
    "{M/D}");
  assert.equal(m[2], weekday, subject);
  assert.equal(`${m[3]}/${m[4]}`, md, subject);
  assert.doesNotMatch(subject, /20\d\d/, "no year");

  return m[1];
};

// A late subject: the marker, and the day's subject with it taken out.
const LATE = /\blate\b:?\s*/i;

const assertLate = (subject, weekday, md) => {
  assert.match(subject, LATE, `"${subject}" is marked late`);

  return assertForm(subject.replace(LATE, "").trim(), weekday, md);
};

const DROP_SUBJECT = "North Scituate drop site packing slips for Saturday " +
  "11/21";
const PREP_SUBJECT = "Pawtucket Thanksgiving Prep packing slips for " +
  "Saturday 11/21";

describe("#694 packing slips just in time, one email per group", () => {
  it("At 3 PM, each fulfillment group with orders tomorrow gets its own " +
    "email and PDF with exactly that group's slips for tomorrow, and " +
    "nothing for later days", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [
      atDrop("NFF-2611-DSA1"), atDrop("NFF-2611-DSB1"),
      atPrep("NFF-2611-TPA1"), atPrep("NFF-2611-TPB1"),
      onFarm("NFF-2611-OFA1"),
      // Later days: a delivery Wednesday, the drop site next Saturday.
      delivered("NFF-2611-DEL1"), atDrop("NFF-2611-DSL1", NEXT_SAT),
    ]);

    const before = await tick(stores, h, at(FRI, 14, 45));
    const mails = await tick(stores, h, at(FRI, 15));
    const again = await tick(stores, h, at(FRI, 15, 15));

    assert.deepEqual(before, [], "not before 3 PM");
    assert.deepEqual(again, [], "once a day");
    assert.equal(mails.length, 3, mails.map((m) => m.subject).join(" | "));
    mails.forEach((m) => assert.equal(m.attachments.length, 1,
      `"${m.subject}" has its own PDF`));
    oneEmailPerGroup(mails, {
      drop: ["NFF-2611-DSA1", "NFF-2611-DSB1"],
      prep: ["NFF-2611-TPA1", "NFF-2611-TPB1"],
      farm: ["NFF-2611-OFA1"],
    });

    // Each pick list holds only its own group's items.
    const items = {
      "NFF-2611-DSA1": "Drop site eggs", "NFF-2611-TPA1": "Prep turkey",
      "NFF-2611-OFA1": "Farm stand chicken",
    };

    for (const [id, item] of Object.entries(items)) {
      const text = pdfOf(mailHolding(mails, id));

      assert.ok(text.includes(item), `${id}'s PDF lists ${item}`);
      Object.values(items).filter((i) => i !== item).forEach((other) =>
        assert.ok(!text.includes(other), `${id}'s PDF lacks ${other}`));
    }

    for (const m of mails) {
      for (const later of ["NFF-2611-DEL1", "NFF-2611-DSL1",
        "Delivered ham"]) {
        assert.ok(!everything(m).includes(later),
          `"${m.subject}" has nothing for later days (${later})`);
      }
    }
  });

  it("At 6 AM, each group with orders for today that arrived, changed or " +
    "were cancelled after the 3 PM packet gets its own email with exactly " +
    "those, and a group with nothing late gets none", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [
      atDrop("NFF-2611-DSA2"), atPrep("NFF-2611-TPA2"),
      atPrep("NFF-2611-TPX2"), onFarm("NFF-2611-OFA2"),
    ]);
    await tick(stores, h, at(FRI, 15));

    // Friday evening: a new drop-site order for Saturday, a Thanksgiving
    // Prep order changed and another cancelled, a delivery for
    // Wednesday. Nothing changes for on-farm pickup.
    await saveOrder(stores, atDrop("NFF-2611-DSC2"), at(FRI, 19));
    await amendOrder(stores, "NFF-2611-TPA2", {
      lines: [{ sku: "SKU-NFF-2611-TPA2", label: "Prep turkey", qty: 5,
        lineTotal: 35 }],
    }, "edited", at(FRI, 19, 30));
    await setStatus(stores, "NFF-2611-TPX2", "cancelled", at(FRI, 20));
    await saveOrder(stores, delivered("NFF-2611-DEL2"), at(FRI, 20));

    const before = await tick(stores, h, at(SAT, 5, 45));
    const mails = await tick(stores, h, at(SAT, 6));
    const again = await tick(stores, h, at(SAT, 6, 15));

    assert.deepEqual(before, [], "not before 6 AM");
    assert.deepEqual(again, [], "once a day");
    assert.equal(mails.length, 2, mails.map((m) => m.subject).join(" | "));
    oneEmailPerGroup(mails, {
      drop: ["NFF-2611-DSC2"],
      prep: ["NFF-2611-TPA2", "NFF-2611-TPX2"],
    });

    const drop = mailHolding(mails, "NFF-2611-DSC2");
    const prep = mailHolding(mails, "NFF-2611-TPA2");

    assert.ok(!pdfOf(drop).includes("NFF-2611-DSA2"),
      "a slip printed at 3 PM and unchanged is not sent again");
    assert.match(pdfOf(prep), /\(REVISED\)/);
    assert.match(pdfOf(prep), /\(CANCELED\)/);
    for (const m of mails) {
      for (const absent of ["NFF-2611-OFA2", "NFF-2611-DEL2"]) {
        assert.ok(!everything(m).includes(absent),
          `"${m.subject}" lacks ${absent}`);
      }
    }
  });

  it("There is no weekly Sunday batch", async () => {
    const stores = testStores();
    const h = harness();
    const week = ["NFF-2611-OFM3", "NFF-2611-DEL3", "NFF-2611-DSL3"];

    // Nothing for Sunday; the coming week's orders, placed Thursday.
    await save(stores, [
      onFarm("NFF-2611-OFM3", MON), delivered("NFF-2611-DEL3", WED),
      atDrop("NFF-2611-DSL3", NEXT_SAT),
    ]);

    const satEve = await tick(stores, h, at(SAT, 15));
    const sunday = await tick(stores, h, at(SUN, 6));

    assert.deepEqual(sunday.map((m) => m.subject), [],
      "Sunday 6 AM sends nothing: nothing for Sunday is late");
    for (const m of [...satEve, ...sunday]) {
      assert.doesNotMatch(m.subject, /week/i);
      week.forEach((id) => assert.ok(!everything(m).includes(id),
        `"${m.subject}" does not carry ${id} early`));
      assert.doesNotMatch(pdfOf(m), /\(Reprint\)/);
    }

    // Monday's slip comes the day before, and only Monday's.
    const sunEve = await tick(stores, h, at(SUN, 15));

    assert.equal(sunEve.length, 1, sunEve.map((m) => m.subject).join(" | "));
    assert.deepEqual(idsIn(sunEve[0], week), ["NFF-2611-OFM3"]);
  });

  it("Each subject reads {place} packing slips for {Weekday} {M/D}, as " +
    "in James's examples, and late ones are marked as late", async () => {
    // Friday 3 PM: James's two subjects, word for word, and on-farm
    // pickup's in their form.
    const fri = testStores();
    const h = harness();

    await save(fri, [
      atDrop("NFF-2611-DSA4"), atPrep("NFF-2611-TPA4"),
      onFarm("NFF-2611-OFA4"),
    ]);

    const eve = await tick(fri, h, at(FRI, 15));
    const subjects = eve.map((m) => m.subject);

    assert.ok(subjects.includes(DROP_SUBJECT), subjects.join(" | "));
    assert.ok(subjects.includes(PREP_SUBJECT), subjects.join(" | "));
    assert.equal(subjects.length, 3, subjects.join(" | "));
    eve.forEach((m) => assertForm(m.subject, "Saturday", "11/21"));
    assert.ok(assertForm(mailHolding(eve, "NFF-2611-OFA4").subject,
      "Saturday", "11/21").length, "on-farm pickup names its place");

    // An order placed Friday evening for Saturday comes at 6 AM in its
    // own email, marked late.
    await saveOrder(fri, atDrop("NFF-2611-DSL4"), at(FRI, 19));

    const late = await tick(fri, h, at(SAT, 6));

    assert.equal(late.length, 1, late.map((m) => m.subject).join(" | "));
    assert.deepEqual(idsIn(late[0], ["NFF-2611-DSA4", "NFF-2611-DSL4"]),
      ["NFF-2611-DSL4"]);
    assert.equal(assertLate(late[0].subject, "Saturday", "11/21"),
      "North Scituate drop site");

    // A market: the town of its location and the occasion's name.
    const mon = testStores();

    await save(mon, [atMarket("NFF-2611-MKT4", TUE)]);

    const [market] = await tick(mon, harness(), at(MON, 15));
    const place = assertForm(market.subject, "Tuesday", "11/24");

    assert.ok(place.includes(townOf(MARKET)), place);
    assert.ok(place.includes(MARKET.name), place);

    // Delivery, on another day of the week.
    const tue = testStores();

    await save(tue, [delivered("NFF-2611-DEL4", WED)]);

    const [del] = await tick(tue, harness(), at(TUE, 15));

    assert.ok(assertForm(del.subject, "Wednesday", "11/25").length);
  });

  it("A day with nothing to print sends the one \"no packing slips\" " +
    "email at 3 PM", async () => {
    const stores = testStores();
    const h = harness();

    // Nothing for Sunday; one order for Monday.
    await save(stores, [onFarm("NFF-2611-OFM5", MON)]);

    const eve = await tick(stores, h, at(SAT, 15));
    const again = await tick(stores, h, at(SAT, 15, 15));
    const morning = await tick(stores, h, at(SUN, 6));

    assert.equal(eve.length, 1, eve.map((m) => m.subject).join(" | "));
    assert.match(eve[0].subject, /^no packing slips for /i);
    assert.match(eve[0].subject, /\bSunday 11\/22$/);
    assert.doesNotMatch(eve[0].subject, /20\d\d/, "no year");
    assert.deepEqual(eve[0].attachments || [], [], "nothing to print");
    assert.ok(!everything(eve[0]).includes("NFF-2611-OFM5"),
      "Monday's order is not Sunday's");
    assert.deepEqual(again, [], "once");
    assert.deepEqual(morning, [], "nothing at 6 AM when nothing is late");
  });

  it("\"Changed after printing\", the printed records, the summaries and " +
    "the healthcheck behave as before", async () => {
    const stores = testStores();
    const h = harness();
    const ids = ["NFF-2611-DSA6", "NFF-2611-TPA6", "NFF-2611-OFA6"];

    await save(stores, [
      atDrop("NFF-2611-DSA6"), atPrep("NFF-2611-TPA6"),
      onFarm("NFF-2611-OFA6"),
    ]);

    const all = (since) => h.sent.slice(since);

    await tick(stores, h, at(FRI, 15));

    // The printed records: what each slip showed, per order.
    const printed = await readPrinted(stores);

    for (const id of ids) {
      assert.deepEqual(printed.get(id).snapshot,
        snapshotOf(await getOrder(stores, id)), `${id} is recorded printed`);
    }

    // The 6 PM summary of tomorrow.
    let from = h.sent.length;
    await tick(stores, h, at(FRI, 18));
    assert.deepEqual(all(from).filter((m) => /^Tomorrow, /.test(m.subject))
      .map((m) => m.subject), ["Tomorrow, Saturday, November 21: 3 orders"]);

    // A reprint comes from comparing with what was printed.
    await amendOrder(stores, "NFF-2611-DSA6", {
      lines: [{ sku: "SKU-NFF-2611-DSA6", label: "Drop site eggs", qty: 5,
        lineTotal: 35 }],
    }, "edited", at(FRI, 20));

    const late = await tick(stores, h, at(SAT, 6));
    const revised = mailHolding(late, "NFF-2611-DSA6");

    assert.ok(revised, late.map((m) => m.subject).join(" | "));
    assert.match(pdfOf(revised), /\(REVISED\)/);
    assert.ok(pdfOf(revised).includes(changesBetween(
      printed.get("NFF-2611-DSA6").snapshot,
      snapshotOf(await getOrder(stores, "NFF-2611-DSA6")))[0]));
    assert.deepEqual((await readPrinted(stores)).get("NFF-2611-DSA6")
      .snapshot, snapshotOf(await getOrder(stores, "NFF-2611-DSA6")),
    "the reprint is recorded printed");

    // The 8 AM morning report.
    from = h.sent.length;
    await tick(stores, h, at(SAT, 8));
    assert.ok(all(from).some((m) => /^Morning report: Saturday, November 21/
      .test(m.subject)), all(from).map((m) => m.subject).join(" | "));

    // "Changed after printing" during the day, for a group the 6 AM run
    // had nothing late for, once.
    await amendOrder(stores, "NFF-2611-TPA6", { notes: "Ring twice" },
      "edited", at(SAT, 9));
    from = h.sent.length;
    await tick(stores, h, at(SAT, 9, 15));

    const changed = all(from).filter((m) =>
      /^Changed after printing/.test(m.subject));

    assert.deepEqual(changed.map((m) => m.subject),
      ["Changed after printing: NFF-2611-TPA6"]);
    assert.match(pdfOf(changed[0]), /\(REVISED\)/);
    assert.match(pdfOf(changed[0]), /Notes or delivery instructions changed/);
    from = h.sent.length;
    await tick(stores, h, at(SAT, 9, 30));
    assert.equal(all(from).filter((m) =>
      /^Changed after printing/.test(m.subject)).length, 0, "once");

    // The healthcheck: the 3 PM run leaves it to the morning; the
    // morning pings once, however many groups it sends, and on a
    // morning with nothing late; /fail when a group's email can't go.
    const run = (s, hh, now, fn) => fn(s, {
      env: LIVE, mail: hh.mail, fetchImpl: hh.fetchImpl, now,
    });
    const ok = testStores();
    const okH = harness();

    await save(ok, [atDrop("NFF-2611-DSH6"), atPrep("NFF-2611-TPH6")]);
    await run(ok, okH, at(FRI, 15), packingEve);
    assert.deepEqual(okH.pings, [], "3 PM leaves the check to the morning");
    await saveOrder(ok, atDrop("NFF-2611-DSI6"), at(FRI, 19));
    await saveOrder(ok, atPrep("NFF-2611-TPI6"), at(FRI, 19));
    await run(ok, okH, at(SAT, 6), packingDaily);
    assert.ok(okH.sent.filter(isPacking).length >= 4,
      "two groups at 3 PM, two late at 6 AM");
    assert.deepEqual(okH.pings.map((p) => p.url), [URL], "once per run");

    const quiet = testStores();
    const quietH = harness();

    await save(quiet, [atDrop("NFF-2611-DSQ6")]);
    await run(quiet, quietH, at(FRI, 15), packingEve);
    await run(quiet, quietH, at(SAT, 6), packingDaily);
    assert.deepEqual(quietH.pings.map((p) => p.url), [URL],
      "a morning with nothing late still pings");

    const down = testStores();
    const downH = harness({
      failWhen: (m) => m.subject.startsWith(PREP_SUBJECT.split(" packing")[0]),
    });

    await save(down, [atDrop("NFF-2611-DSF6"), atPrep("NFF-2611-TPF6")]);
    await assert.rejects(run(down, downH, at(FRI, 15), packingEve),
      /Resend 503/, "a group's email that can't go fails the run");
    assert.deepEqual(downH.pings.map((p) => p.url), [`${URL}/fail`]);
  });
});
