// Criteria tests for #694 round two (packing slips just in time, one
// email per kind of fulfillment): James's revision of 2026-11-20, from
// its "Done when" boxes, written before any code. One test per open
// box, named for it. The Sunday batch box is met (8e7eccae) and keeps
// its test in test/packing-groups.test.mjs; the last box (the reviews
// and James's approval) is not a test. Held out of `npm test` by its
// name until the implementer turns it on with
//
//   git mv test/packing-kinds.criteria.mjs test/packing-kinds.test.mjs
//
// The three kinds: on-farm pickups; market/drop site pickups (the
// drop site, each market and each pop-up, together); deliveries.
// James's subjects and bodies (spec items 2 to 4) are pinned as he
// wrote them, each subject in one constant. His "on" in the 3 PM
// market/drop site subject, against "for" everywhere else, is pinned
// as written while he is asked whether it is deliberate. A body is
// read from the email's text with the markup taken off (the bullets
// and the asterisks), and its bold from the HTML. Every test drives
// the real 15-minute jobs run with a pinned clock, as round one's
// test/packing-groups.test.mjs does; every order is a fake from the
// staging library, and no mail leaves the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

// --- James's words (spec items 2 to 4) ----------------------------------

// The subjects. `day` is "Saturday, 11/21".
const EVE_ONFARM = (day) => `Packing slips: on-farm pickups for ${day}`;
const EVE_MARKET = (day) =>
  `Packing slips: market/drop site pickups on ${day}`;
const EVE_DELIVERY = (day) => `Packing slips: deliveries for ${day}`;
const LATE_ONFARM = (day) =>
  `Packing slips — new since yesterday: on-farm pickups for ${day}`;
const LATE_MARKET = (day) =>
  `Packing slips — new since yesterday: market/drop site pickups for ${day}`;
const LATE_DELIVERY = (day) =>
  `Packing slips — new since yesterday: deliveries for ${day}`;

// The 3 PM body, market/drop site pickups, for Saturday 11/21.
const EVE_BODY = [
  "Print the attached PDF, which contains packing slips for all market, " +
    "pop-up, and drop site pickup orders for Saturday, 11/21.",
  "",
  "Any new orders, changes to existing orders, or order cancellations " +
    "received after 3 PM today will be resent tomorrow morning at 6 AM.",
  "",
  "**Included in this packet**",
  "",
  "• **North Scituate drop site: 2 slips:**",
  "  • Lee Marchetti (NFF-2611-DS7A)",
  "  • Robin Ashby (NFF-2611-DS9K)",
  "• **Thanksgiving Prep pop-up: 1 slip**",
  "  • John Doe (NFF-2999-D876)",
];

// The 6 AM body, market/drop site pickups, for Saturday 11/21.
const LATE_BODY = [
  "Print the attached PDF, which contains **new, changed, or canceled** " +
    "packing slips for all market, pop-up, and drop site pickup orders " +
    "for Saturday, 11/21.",
  "",
  "**Included in this packet**",
  "",
  "• **North Scituate drop site: 2 slips:**",
  "  • Lee Marchetti (NFF-2611-DS7A) **(new)**",
  "  • Robin Ashby (NFF-2611-DS9K) **(changed)**",
  "• **Thanksgiving Prep pop-up: 1 slip**",
  "  • John Doe (NFF-2999-D876) **(canceled)**",
];

// --- Clock, places and orders -----------------------------------------

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

const seriesNamed = (pred) => series.series.find(pred);
const DROP = seriesNamed((s) => s.kind === "drop-site");
const PREP = seriesNamed((s) => s.name === "Thanksgiving Prep");
const MARKET = seriesNamed((s) => s.name === "Pawtucket Farmers Market");

const occurrence = (s, date) => ({
  method: "scheduled", occurrence: `${s.code}-${date.slice(2)
    .replaceAll("-", "")}`, date, onfarm: null, delivery: null,
});

// A fake order from the library's builders: `id`, its fulfillment, one
// line whose label names its kind (so a pick list shows whose items it
// holds) and the customer's name.
const fake = (id, build, fulfilment, item, name = "Dana Whitcomb") => {
  const o = build({
    id, submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
    emails: { orderConfirmed: { at: placed.toISOString() } },
    lines: [{ sku: `SKU-${id}`, label: item, qty: 2, lineTotal: 14 }],
    fulfilment,
  });
  const [firstName, ...rest] = name.split(" ");

  return {
    ...o, customer: { ...o.customer, firstName, lastName: rest.join(" "),
      name },
  };
};

const atDrop = (id, { date = SAT, item = "Drop site eggs", name } = {}) =>
  fake(id, dropSite, occurrence(DROP, date), item, name);
const atPrep = (id, { item = "Prep turkey", name } = {}) =>
  fake(id, popUp, occurrence(PREP, SAT), item, name);
const atMarket = (id, { date = TUE, item = "Market sausage", name } = {}) =>
  fake(id, popUp, occurrence(MARKET, date), item, name);
const onFarm = (id, { date = SAT, item = "Farm stand chicken", name } = {}) =>
  fake(id, pickup, { ...pickup().fulfilment, date }, item, name);
const delivered = (id, { date = SAT, item = "Delivered ham", name } = {}) =>
  fake(id, delivery, { ...delivery().fulfilment, date }, item, name);

// --- The mail -----------------------------------------------------------

// `sent` holds what went; `tried` every call, failed or not, with the
// run (`now`) it came from.
const harness = ({ failWhen = null } = {}) => {
  const sent = [];
  const tried = [];
  const pings = [];
  let now = null;

  return {
    sent, tried, pings,
    at: (when) => { now = when; },
    mail: async (m) => {
      tried.push({ m, now });
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

const isPacking = (m) => /packing slips/i.test(m.subject);

// One 15-minute run of the real job. -> the packing emails it sent.
const tick = async (stores, h, now, env = FARM) => {
  const from = h.sent.length;

  h.at(now);
  await runJobs(stores, { env, mail: h.mail, fetchImpl: h.fetchImpl, now });

  return h.sent.slice(from).filter(isPacking);
};

// Every 15-minute run from `from` through `to`, inclusive.
const quarters = (from, to) => {
  const runs = [];

  for (let t = from.getTime(); t <= to.getTime(); t += 15 * 60 * 1000) {
    runs.push(new Date(t));
  }

  return runs;
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
const subjects = (mails) => mails.map((m) => m.subject).join(" | ");

// The ids of `ids` an email's PDF holds, sorted.
const idsIn = (m, ids) => ids.filter((id) => pdfOf(m).includes(id)).sort();

// Each email's PDF holds exactly one kind's orders, and each kind has
// exactly one email. `kinds` maps a name to its ids.
const oneEmailPerKind = (mails, kinds) => {
  const all = Object.values(kinds).flat();
  const seen = mails.map((m) => idsIn(m, all).join(","));
  const want = Object.values(kinds).map((k) => [...k].sort().join(","));

  assert.deepEqual([...seen].sort(), [...want].sort(),
    `one email per kind: ${subjects(mails)}`);
};

const mailHolding = (mails, id) => mails.find((m) => pdfOf(m).includes(id));

// --- Reading a body ---------------------------------------------------

// A line without its markup: its indent, and its words with the bullet
// and the asterisks taken off.
const lineOf = (raw) => ({
  indent: raw.match(/^\s*/)[0].length,
  words: raw.trim().replace(/^[•\-*]\s+/, "").replaceAll("**", "").trim(),
});
const linesOf = (text) => text.split("\n").map(lineOf)
  .filter((l) => l.words);

// James's body is in the email's text, word for word, line for line,
// with nothing between its lines, and each order nested under its
// place as he wrote it; what he set in bold is bold in the HTML.
const assertBody = (m, body) => {
  const want = linesOf(body.join("\n"));
  const have = linesOf(m.text);
  const words = have.map((l) => l.words);
  const start = words.findIndex((w, i) => want.every((l, k) =>
    words[i + k] === l.words));

  assert.ok(start !== -1, `"${m.subject}" reads as James wrote it.\n` +
    `Wanted:\n${want.map((l) => l.words).join("\n")}\n\nGot:\n${m.text}`);

  const sign = (n) => Math.sign(n);

  for (let k = 1; k !== want.length; k += 1) {
    assert.equal(sign(have[start + k].indent - have[start + k - 1].indent),
      sign(want[k].indent - want[k - 1].indent),
      `"${want[k].words}" sits under "${want[k - 1].words}" as James ` +
      "nested it");
  }

  const bold = body.join("\n").match(/\*\*([^*]+)\*\*/g)
    .map((s) => s.slice(2, -2));

  for (const b of bold) {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.match(m.html, new RegExp(`<(strong|b|h[1-6])\\b[^>]*>${esc}</\\1>`),
      `"${b}" is bold`);
  }
};

describe("#694 round two: packing slips just in time, one email per " +
  "kind of fulfillment", () => {
  it("At 3 PM, each kind of fulfillment with orders tomorrow gets one " +
    "email and one PDF with all of its slips for tomorrow, and nothing " +
    "for later days", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [
      onFarm("NFF-2611-OFA1"), onFarm("NFF-2611-OFB1"),
      atDrop("NFF-2611-DSA1"), atDrop("NFF-2611-DSB1"),
      atPrep("NFF-2611-TPA1"),
      delivered("NFF-2611-DLA1"),
      // Later days: a market Tuesday, a delivery Wednesday, the drop
      // site next Saturday.
      atMarket("NFF-2611-MKL1"), delivered("NFF-2611-DLL1", { date: WED }),
      atDrop("NFF-2611-DSL1", { date: NEXT_SAT }),
    ]);

    const before = await tick(stores, h, at(FRI, 14, 45));
    const mails = await tick(stores, h, at(FRI, 15));
    const again = await tick(stores, h, at(FRI, 15, 15));

    assert.deepEqual(before, [], "not before 3 PM");
    assert.deepEqual(again, [], "once a day");
    assert.equal(mails.length, 3, subjects(mails));
    for (const m of mails) {
      assert.equal(m.attachments.length, 1, `"${m.subject}" has one PDF`);
      assert.equal(m.attachments[0].contentType, "application/pdf");
    }
    oneEmailPerKind(mails, {
      onfarm: ["NFF-2611-OFA1", "NFF-2611-OFB1"],
      market: ["NFF-2611-DSA1", "NFF-2611-DSB1", "NFF-2611-TPA1"],
      delivery: ["NFF-2611-DLA1"],
    });

    // Each pick list holds its own kind's items and no other's.
    const items = {
      "NFF-2611-OFA1": ["Farm stand chicken"],
      "NFF-2611-DSA1": ["Drop site eggs", "Prep turkey"],
      "NFF-2611-DLA1": ["Delivered ham"],
    };
    const every = Object.values(items).flat();

    for (const [id, own] of Object.entries(items)) {
      const text = pdfOf(mailHolding(mails, id));

      own.forEach((i) => assert.ok(text.includes(i), `${id}'s PDF lists ${i}`));
      every.filter((i) => !own.includes(i)).forEach((other) =>
        assert.ok(!text.includes(other), `${id}'s PDF lacks ${other}`));
    }

    for (const m of mails) {
      for (const later of ["NFF-2611-MKL1", "NFF-2611-DLL1",
        "NFF-2611-DSL1", "Market sausage"]) {
        assert.ok(!everything(m).includes(later),
          `"${m.subject}" has nothing for later days (${later})`);
      }
    }
  });

  it("At 6 AM, each kind with orders for today that came in, changed or " +
    "were canceled after the 3 PM packet gets one email with exactly " +
    "those; a kind with nothing late gets none", async () => {
    const stores = testStores();
    const h = harness();

    await save(stores, [
      onFarm("NFF-2611-OFA2"),
      atDrop("NFF-2611-DSA2"), atPrep("NFF-2611-TPA2"),
      atPrep("NFF-2611-TPB2"),
      delivered("NFF-2611-DLA2"), delivered("NFF-2611-DLB2"),
    ]);
    await tick(stores, h, at(FRI, 15));

    // Friday evening: a new drop site order for Saturday, a Thanksgiving
    // Prep order canceled, a delivery changed, and a delivery for
    // Wednesday. Nothing changes for on-farm pickup.
    await saveOrder(stores, atDrop("NFF-2611-DSC2"), at(FRI, 19));
    await setStatus(stores, "NFF-2611-TPA2", "cancelled", at(FRI, 19, 30));
    await amendOrder(stores, "NFF-2611-DLA2", {
      lines: [{ sku: "SKU-NFF-2611-DLA2", label: "Delivered ham", qty: 5,
        lineTotal: 35 }],
    }, "edited", at(FRI, 20));
    await saveOrder(stores, delivered("NFF-2611-DLW2", { date: WED }),
      at(FRI, 20));

    const before = await tick(stores, h, at(SAT, 5, 45));
    const mails = await tick(stores, h, at(SAT, 6));
    const again = await tick(stores, h, at(SAT, 6, 15));

    assert.deepEqual(before, [], "not before 6 AM");
    assert.deepEqual(again, [], "once a day");
    assert.equal(mails.length, 2, subjects(mails));
    oneEmailPerKind(mails, {
      market: ["NFF-2611-DSC2", "NFF-2611-TPA2"],
      delivery: ["NFF-2611-DLA2"],
    });

    const market = mailHolding(mails, "NFF-2611-DSC2");
    const deliveries = mailHolding(mails, "NFF-2611-DLA2");

    assert.match(pdfOf(market), /\(CANCELED\)/);
    assert.match(pdfOf(deliveries), /\(REVISED\)/);
    for (const m of mails) {
      for (const absent of ["NFF-2611-OFA2", "NFF-2611-DSA2",
        "NFF-2611-TPB2", "NFF-2611-DLB2", "NFF-2611-DLW2"]) {
        assert.ok(!everything(m).includes(absent),
          `"${m.subject}" lacks ${absent}: printed at 3 PM and unchanged, ` +
          "or not today's");
      }
    }
  });

  it("The subjects read as James wrote them in spec item 2", async () => {
    const stores = testStores();
    const h = harness();
    const sorted = (mails) => mails.map((m) => m.subject).sort();

    await save(stores, [
      onFarm("NFF-2611-OFA3"), atDrop("NFF-2611-DSA3"),
      delivered("NFF-2611-DLA3"),
      atMarket("NFF-2611-MKA3", { date: TUE }),
      delivered("NFF-2611-DLW3", { date: WED }),
    ]);

    // 3 PM Friday, for Saturday.
    assert.deepEqual(sorted(await tick(stores, h, at(FRI, 15))), [
      EVE_DELIVERY("Saturday, 11/21"), EVE_MARKET("Saturday, 11/21"),
      EVE_ONFARM("Saturday, 11/21"),
    ].sort());

    // 6 AM Saturday: one late order of each kind.
    await save(stores, [
      onFarm("NFF-2611-OFL3"), atDrop("NFF-2611-DSL3"),
      delivered("NFF-2611-DLL3"),
    ], at(FRI, 19));
    assert.deepEqual(sorted(await tick(stores, h, at(SAT, 6))), [
      LATE_DELIVERY("Saturday, 11/21"), LATE_MARKET("Saturday, 11/21"),
      LATE_ONFARM("Saturday, 11/21"),
    ].sort());

    // James's other two examples: the market on Tuesday, a delivery on
    // Wednesday.
    assert.deepEqual(sorted(await tick(stores, h, at(MON, 15))),
      [EVE_MARKET("Tuesday, 11/24")]);
    assert.deepEqual(sorted(await tick(stores, h, at(TUE, 15))),
      [EVE_DELIVERY("Wednesday, 11/25")]);
  });

  it("The 3 PM and 6 AM bodies read as James wrote them in spec items 3 " +
    "and 4: each place or occasion with its count, each order as name " +
    "then order number, and at 6 AM each marked new, changed or canceled",
  async () => {
    const LEE = { name: "Lee Marchetti" };
    const ROBIN = { name: "Robin Ashby" };
    const JOHN = { name: "John Doe" };

    // 3 PM: James's example, word for word.
    const eve = testStores();
    const h = harness();

    await save(eve, [
      atDrop("NFF-2611-DS7A", LEE), atDrop("NFF-2611-DS9K", ROBIN),
      atPrep("NFF-2999-D876", JOHN),
      onFarm("NFF-2611-OF4B", { name: "Sam Fielder" }),
      delivered("NFF-2611-DL4C", { name: "Kit Rowe" }),
    ]);

    const three = await tick(eve, h, at(FRI, 15));
    // Each email found by the order it holds, so a subject's wording
    // does not hide its body's (the subjects are the box before).
    const market = mailHolding(three, "NFF-2611-DS7A");

    assert.ok(market, subjects(three));
    assertBody(market, EVE_BODY);
    assert.doesNotMatch(market.text, /\((new|changed|canceled)\)/i,
      "no marker at 3 PM");
    assert.doesNotMatch(market.text, /replace|printed/i,
      "nothing about slips printed earlier");

    // The other kinds name themselves the same way.
    for (const [who, id] of [
      ["Sam Fielder", "NFF-2611-OF4B"], ["Kit Rowe", "NFF-2611-DL4C"],
    ]) {
      const m = mailHolding(three, id);

      assert.ok(m, subjects(three));

      const lines = linesOf(m.text).map((l) => l.words);
      const first = lines.findIndex((l) =>
        l.startsWith("Print the attached PDF"));
      const order = lines.indexOf(`${who} (${id})`);

      assert.match(lines[first], new RegExp("^Print the attached PDF, " +
        "which contains packing slips for all .+ orders for Saturday, " +
        "11/21\\.$"));
      assert.doesNotMatch(lines[first], /market|drop site/);
      assert.equal(lines[first + 1], linesOf(EVE_BODY.join("\n"))[1].words);
      assert.equal(lines[first + 2], "Included in this packet");
      assert.ok(order > first + 3, `${who} (${id}) is listed: ${m.text}`);
      assert.match(lines[order - 1], /: 1 slip:?$/, "its count");
    }

    // 6 AM: James's example, word for word. Robin and John went at
    // 3 PM; then Lee came in, Robin changed and John canceled.
    const late = testStores();
    const l = harness();

    await save(late, [
      atDrop("NFF-2611-DS9K", ROBIN), atPrep("NFF-2999-D876", JOHN),
    ]);
    await tick(late, l, at(FRI, 15));
    await saveOrder(late, atDrop("NFF-2611-DS7A", LEE), at(FRI, 19));
    await amendOrder(late, "NFF-2611-DS9K", { notes: "Ring twice" },
      "edited", at(FRI, 19, 30));
    await setStatus(late, "NFF-2999-D876", "cancelled", at(FRI, 20));

    const six = await tick(late, l, at(SAT, 6));

    const lee = mailHolding(six, "NFF-2611-DS7A");

    assert.ok(lee, subjects(six));
    assertBody(lee, LATE_BODY);
  });

  it("A failed 3 PM send is retried every 15 minutes until it goes, " +
    "identical to the on-time email, and there is no 6 AM catch-up email",
  async () => {
    const early = ["NFF-2611-OFE6", "NFF-2611-DSE6"];
    const orders = () => [onFarm(early[0]), atDrop(early[1])];
    const holdsEarly = (m) => idsIn(m, early).length > 0;
    const same = (m) => ({
      to: m.to, subject: m.subject, text: m.text, html: m.html,
      attachments: m.attachments,
    });

    // The on-time 3 PM emails, from a run where mail works.
    const ref = testStores();

    await save(ref, orders());

    const onTime = (await tick(ref, harness(), at(FRI, 15))).map(same)
      .sort((a, b) => a.subject.localeCompare(b.subject));

    assert.equal(onTime.length, 2, "the on-time emails");

    // The same day where every 3 PM send fails. `down` is the last run
    // whose 3 PM sends fail.
    const failing = async (down, up) => {
      const stores = testStores();
      let failingNow = true;
      const h = harness({ failWhen: (m) => failingNow && holdsEarly(m) });

      await save(stores, orders());
      for (const now of quarters(at(FRI, 15), down)) {
        // A late order, after the 3 PM packet was fixed.
        if (now.getTime() === at(FRI, 19).getTime()) {
          await saveOrder(stores, atDrop("NFF-2611-DSL6"), at(FRI, 18, 50));
        }
        await tick(stores, h, now);

        const tried = h.tried.filter((t) => t.now === now && holdsEarly(t.m))
          .map((t) => t.m.subject).sort();

        assert.deepEqual(tried, onTime.map((m) => m.subject),
          `each 3 PM email is tried again at ${now.toISOString()}`);
      }

      // Every try was the on-time email: none a catch-up.
      for (const { m, now } of h.tried.filter((t) => holdsEarly(t.m))) {
        assert.deepEqual(same(m), onTime.find((x) => x.subject === m.subject),
          `the try at ${now.toISOString()} is the on-time email`);
      }

      failingNow = false;

      const went = (await tick(stores, h, up)).filter(holdsEarly).map(same)
        .sort((a, b) => a.subject.localeCompare(b.subject));

      assert.deepEqual(went, onTime, "what goes is the on-time email");
      assert.deepEqual((await tick(stores, h, new Date(up.getTime() +
        15 * 60 * 1000))).filter(holdsEarly), [], "once");

      return { stores, h };
    };

    // It goes after midnight; the 6 AM run then sends only the late
    // order, as on any day.
    const { stores, h } = await failing(at(SAT, 0), at(SAT, 0, 15));
    const six = await tick(stores, h, at(SAT, 6));

    assert.deepEqual(six.map((m) => m.subject),
      [LATE_MARKET("Saturday, 11/21")]);
    assert.deepEqual(idsIn(six[0], [...early, "NFF-2611-DSL6"]),
      ["NFF-2611-DSL6"], "no catch-up: the 3 PM slips are not in it");

    // Still failing at 6 AM: the 6 AM run sends no catch-up email of
    // its own, and the retry that goes is still the on-time email.
    await failing(at(SAT, 6), at(SAT, 6, 15));
  });

  it("A day with nothing to print sends no email", async () => {
    const stores = testStores();
    const h = harness();

    // Nothing for Sunday; one order for Monday.
    await save(stores, [onFarm("NFF-2611-OFM7", { date: MON })]);

    const sat = [];

    for (const now of quarters(at(SAT, 15), at(SAT, 21))) {
      sat.push(...await tick(stores, h, now));
    }

    const sun = await tick(stores, h, at(SUN, 6));

    assert.deepEqual(sat.map((m) => m.subject), [],
      "no email at 3 PM for a day with nothing to print");
    assert.deepEqual(sun.map((m) => m.subject), [],
      "nor at 6 AM with nothing late");

    // Monday's order still goes the day before.
    const sunEve = await tick(stores, h, at(SUN, 15));

    assert.deepEqual(sunEve.map((m) => m.subject),
      [EVE_ONFARM("Monday, 11/23")]);
  });

  it("\"Changed after printing\", the printed records, the summaries and " +
    "the healthcheck behave as before", async () => {
    const stores = testStores();
    const h = harness();
    const ids = ["NFF-2611-DSA8", "NFF-2611-TPA8", "NFF-2611-OFA8"];

    await save(stores, [
      atDrop("NFF-2611-DSA8"), atPrep("NFF-2611-TPA8"),
      onFarm("NFF-2611-OFA8"),
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
    await amendOrder(stores, "NFF-2611-DSA8", {
      lines: [{ sku: "SKU-NFF-2611-DSA8", label: "Drop site eggs", qty: 5,
        lineTotal: 35 }],
    }, "edited", at(FRI, 20));

    const late = await tick(stores, h, at(SAT, 6));
    const revised = mailHolding(late, "NFF-2611-DSA8");

    assert.ok(revised, subjects(late));
    assert.match(pdfOf(revised), /\(REVISED\)/);
    assert.ok(pdfOf(revised).includes(changesBetween(
      printed.get("NFF-2611-DSA8").snapshot,
      snapshotOf(await getOrder(stores, "NFF-2611-DSA8")))[0]));
    assert.deepEqual((await readPrinted(stores)).get("NFF-2611-DSA8")
      .snapshot, snapshotOf(await getOrder(stores, "NFF-2611-DSA8")),
    "the reprint is recorded printed");

    // The 8 AM morning report.
    from = h.sent.length;
    await tick(stores, h, at(SAT, 8));
    assert.ok(all(from).some((m) => /^Morning report: Saturday, November 21/
      .test(m.subject)), subjects(all(from)));

    // "Changed after printing" during the day, for a kind the 6 AM run
    // had nothing late for, once.
    await amendOrder(stores, "NFF-2611-OFA8", { notes: "Ring twice" },
      "edited", at(SAT, 9));
    from = h.sent.length;
    await tick(stores, h, at(SAT, 9, 15));

    const changed = all(from).filter((m) =>
      /^Changed after printing/.test(m.subject));

    assert.deepEqual(changed.map((m) => m.subject),
      ["Changed after printing: NFF-2611-OFA8"]);
    assert.match(pdfOf(changed[0]), /\(REVISED\)/);
    assert.match(pdfOf(changed[0]), /Notes or delivery instructions changed/);
    from = h.sent.length;
    await tick(stores, h, at(SAT, 9, 30));
    assert.equal(all(from).filter((m) =>
      /^Changed after printing/.test(m.subject)).length, 0, "once");

    // The healthcheck: the 3 PM run leaves it to the morning; the
    // morning pings once, however many kinds it sends, and on a morning
    // with nothing late; /fail when a kind's email can't go.
    const run = (s, hh, now, fn) => fn(s, {
      env: LIVE, mail: hh.mail, fetchImpl: hh.fetchImpl, now,
    });
    const ok = testStores();
    const okH = harness();

    await save(ok, [atDrop("NFF-2611-DSH8"), onFarm("NFF-2611-OFH8")]);
    await run(ok, okH, at(FRI, 15), packingEve);
    assert.deepEqual(okH.pings, [], "3 PM leaves the check to the morning");
    await saveOrder(ok, atDrop("NFF-2611-DSI8"), at(FRI, 19));
    await saveOrder(ok, onFarm("NFF-2611-OFI8"), at(FRI, 19));
    await run(ok, okH, at(SAT, 6), packingDaily);
    assert.equal(okH.sent.filter(isPacking).length, 4,
      "two kinds at 3 PM, two late at 6 AM");
    assert.deepEqual(okH.pings.map((p) => p.url), [URL], "once per run");

    const quiet = testStores();
    const quietH = harness();

    await save(quiet, [atDrop("NFF-2611-DSQ8")]);
    await run(quiet, quietH, at(FRI, 15), packingEve);
    await run(quiet, quietH, at(SAT, 6), packingDaily);
    assert.deepEqual(quietH.pings.map((p) => p.url), [URL],
      "a morning with nothing late still pings");

    const down = testStores();
    const downH = harness({
      failWhen: (m) => idsIn(m, ["NFF-2611-OFF8"]).length > 0,
    });

    await save(down, [atDrop("NFF-2611-DSF8"), onFarm("NFF-2611-OFF8")]);
    await assert.rejects(run(down, downH, at(FRI, 15), packingEve),
      /Resend 503/, "a kind's email that can't go fails the run");
    assert.deepEqual(downH.pings.map((p) => p.url), [`${URL}/fail`]);
  });
});
