// The daily packing slips (#292). Every order here is fake.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { samplePacket } from "../netlify/functions/lib/library.mjs";
import {
  MailError, OUTBOX_PREFIX, sendMail,
} from "../netlify/functions/lib/mail.mjs";
import {
  PENDING, PING_KEY, SENT, changedAfterPrint, changesBetween, choose, packetPdf,
  packingDaily, paymentState, pickList, readPrinted, snapshotOf,
} from "../netlify/functions/lib/packing.mjs";
import {
  pdf, printable, widthOf, wrap,
} from "../netlify/functions/lib/pdf.mjs";
import {
  amendOrder, saveOrder, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);
const URL = "https://hc-ping.example/packing-check";

// Tuesday 6 October 2026; the week's Sunday is the 11th.
const TUESDAY = "2026-10-06";
const placed = at("2026-10-05", 9);

const order = (id, {
  method = "delivery", date = "2026-10-08", lines, paid = true, ...over
} = {}) => {
  const items = lines || [
    { sku: "EGG-L", label: "Eggs, Large", qty: 2, lineTotal: 14 },
    { sku: "BB-1", label: "Boneless Breasts 1.0 – 1.2 lbs", qty: 1,
      lineTotal: 18 },
  ];
  const subtotal = items.reduce((s, l) => s + l.lineTotal * 100, 0);
  const fee = method === "delivery" ? 500 : 0;

  return {
    id, status: "paid",
    submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
    customer: {
      name: "Pat Example", email: "pat@example.com", phone: "401-555-0100",
    },
    lines: items,
    totals: {
      subtotal, discountAmount: 0, deliveryFee: fee, total: subtotal + fee,
    },
    fulfilment: {
      method, date,
      onfarm: method === "onfarm"
        ? { window: "09:00-12:00", from: "09:00", to: "12:00" } : null,
      delivery: method === "delivery" ? {
        address1: "1 Example Rd", town: "Foster", state: "RI", zip: "02825",
        cooler: "Porch",
      } : null,
    },
    payments: paid ? [{
      amount: subtotal + fee, via: "square", method: "card",
      at: placed.toISOString(), squarePaymentId: `PAY-${id}`,
    }] : [],
    square: { squareOrderId: `SQ-${id}` },
    emails: { orderConfirmed: { at: placed.toISOString() } },
    ...over,
  };
};

const FARM = { FARM_NOTIFICATIONS_EMAIL: "farm@example.com" };
// Production, sending for real, with the check configured.
const LIVE = { ...FARM, MAIL_DRIVER: "resend", [PING_KEY]: URL };

const harness = ({ failMail = false } = {}) => {
  const sent = [];
  const pings = [];

  return {
    sent, pings,
    mail: async (m) => {
      if (failMail) throw new Error("Resend 503");
      sent.push(m);

      return { id: `m${sent.length}` };
    },
    fetchImpl: async (url, init = {}) => {
      pings.push({ url, method: init.method || "GET", body: init.body });

      return new Response("OK", { status: 200 });
    },
  };
};

const run = (stores, h, now, env = LIVE) =>
  packingDaily(stores, { env, mail: h.mail, fetchImpl: h.fetchImpl, now });

const pdfText = (m) => Buffer.from(m.attachments[0].content, "base64")
  .toString("latin1");

describe("the PDF writer", () => {
  it("writes a PDF whose cross-reference points at every object", () => {
    const doc = pdf({ title: "T" });

    doc.page();
    doc.text("Eggs (Large) \\ × 2 – café", 54, 72, { bold: true });
    doc.page();
    doc.rect(54, 100, 100, 20, { fill: 0.9 });

    const out = doc.bytes().toString("latin1");
    const xref = Number(out.match(/startxref\n(\d+)/)[1]);
    const offsets = [...out.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)]
      .map((m) => Number(m[1]));

    assert.ok(out.startsWith("%PDF-1.4\n"));
    assert.ok(out.endsWith("%%EOF\n"));
    assert.equal(out.slice(xref, xref + 4), "xref");
    offsets.forEach((o, i) => assert.ok(
      out.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
    assert.match(out, /\/Count 2/);
    assert.ok(out.includes("(Eggs \\(Large\\) \\\\ \\327 2 \\226 caf\\351)"),
      "escaped, in WinAnsi");
  });

  it("prints what WinAnsi can't hold as ? and breaks long text", () => {
    assert.equal(printable("Eggs 🥚\nLarge"), "Eggs ? Large");
    assert.ok(widthOf("WWW", { bold: true }) > widthOf("iii"));
    assert.deepEqual(wrap("one two three", widthOf("one two")),
      ["one two", "three"]);
    assert.ok(wrap("x".repeat(200), 100).every((l) => widthOf(l) <= 100));
  });

  it("wraps a long unbroken note in time, and caps its rows", () => {
    const note = "é".repeat(2000);
    const all = wrap(note, 400, { size: 11 });
    const capped = wrap(note, 400, { size: 11, rows: 12 });

    // In time: eight times the note takes about eight times as long, not
    // the sixty-four a quadratic wrap would. A ratio, best of five, so a
    // loaded machine slows both sides alike (#159).
    const best = (n) => {
      const long = "é".repeat(n);
      let fastest = Infinity;

      for (let i = 0; i !== 5; i += 1) {
        const started = performance.now();

        wrap(long, 400, { size: 11 });
        fastest = Math.min(fastest, performance.now() - started);
      }

      return fastest;
    };

    best(500);
    const ratio = best(4000) / best(500);

    assert.ok(ratio < 24, `8x the note took ${ratio.toFixed(1)}x as long`);
    assert.equal(all.join(""), note, "nothing lost");
    assert.equal(capped.length, 12);
    assert.ok(capped[11].endsWith("…"));
    assert.ok(capped.every((l) => widthOf(l, { size: 11 }) <= 400));
    assert.deepEqual(wrap("WW", 1), ["W", "W"],
      "a glyph wider than the line still moves on");
  });
});

describe("what goes in a packet", () => {
  it("prints each new order once, and nothing on a quiet day after",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, order("A"), placed);
      await saveOrder(stores, order("B", { method: "onfarm" }), placed);

      const first = await run(stores, h, at(TUESDAY, 6));
      const quiet = await run(stores, h, at("2026-10-07", 6));

      assert.equal(first.slips, 2);
      assert.equal(h.sent[0].subject, "Packing slips, Tuesday, October 6: " +
        "2 slips");
      assert.deepEqual(h.sent[0].to, ["farm@example.com"]);
      assert.equal(h.sent[0].attachments[0].filename,
        "packing-slips-2026-10-06.pdf");
      assert.equal(h.sent[0].attachments[0].contentType, "application/pdf");

      assert.equal(quiet.quiet, true);
      assert.equal(h.sent[1].subject, "Packing slips, Wednesday, " +
        "October 7: nothing to print");
      assert.match(h.sent[1].text,
        /No order has come in, changed or been\s+cancelled/);
      assert.deepEqual(h.sent[1].attachments, []);
    });

  it("waits for 6:00 ET and sends once a day, across a clock change",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, order("A", { date: "2026-11-05" }), placed);

      // Monday 2 November is the first day of EST: 6:00 is 11:00 UTC.
      const five = await run(stores, h,
        new Date("2026-11-02T10:59:00.000Z"));
      const six = await run(stores, h, new Date("2026-11-02T11:00:00.000Z"));
      const again = await run(stores, h,
        new Date("2026-11-02T11:15:00.000Z"));

      assert.equal(five, null);
      assert.equal(six.slips, 1);
      assert.equal(again, null);
      assert.equal(h.sent.length, 1);
    });

  it("puts the whole week in Sunday's packet, and new later orders",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, order("THU", { date: "2026-10-15" }), placed);
      await saveOrder(stores, order("SAT", {
        method: "scituate", date: "2026-10-17",
      }), placed);
      await saveOrder(stores, order("NEXT", { date: "2026-10-22" }), placed);
      // All three printed during the week before.
      await run(stores, h, at("2026-10-09", 6));
      // A new order for the week after, placed Saturday.
      await saveOrder(stores, order("LATER", { date: "2026-10-29" }), placed);

      const sunday = await run(stores, h, at("2026-10-11", 6));
      const ids = (await stores.jobs.get(`${SENT}2026-10-11`)).ids;

      assert.equal(sunday.sunday, true);
      assert.deepEqual(ids, ["THU", "SAT", "LATER"],
        "the week's orders by date and type, then the new one; not NEXT");
      assert.match(h.sent[1].subject,
        /^Packing slips for the week of Sunday, October 11: 3 slips$/);
      assert.match(pdfText(h.sent[1]), /Packing slips for the week of/);
    });

  it("sorts by date, then type, then pickup time", () => {
    const entries = choose({
      open: [
        order("P2", { method: "onfarm", onfarm: null, fulfilment: {
          method: "onfarm", date: "2026-10-08",
          onfarm: { window: "13:00-15:00", from: "13:00", to: "15:00" },
        } }),
        order("P1", { method: "onfarm" }),
        order("D", { date: "2026-10-08" }),
        order("S", { method: "scituate", date: "2026-10-07" }),
      ],
      printed: new Map(), gone: [], day: TUESDAY,
    });

    assert.deepEqual(entries.map((e) => e.order.id), ["S", "D", "P1", "P2"]);
  });

  it("totals the pick list across the slips", () => {
    const entries = [order("A"), order("B", {
      lines: [{ sku: "EGG-L", label: "Eggs, Large", qty: 1, lineTotal: 7 }],
    })].map((o) => ({ order: o, kind: "new", changes: [] }));

    assert.deepEqual(pickList(entries), [
      { label: "Boneless Breasts 1.0 – 1.2 lbs", qty: 1 },
      { label: "Eggs, Large", qty: 3 },
    ]);
  });
});

describe("changed and cancelled orders", () => {
  it("prints a revision sheet and a fresh slip for a change, once",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, order("A"), placed);
      await saveOrder(stores, order("B"), placed);
      await run(stores, h, at(TUESDAY, 6));
      await amendOrder(stores, "A", {
        lines: [{ sku: "EGG-L", label: "Eggs, Large", qty: 5, lineTotal: 35 }],
        fulfilment: { ...order("A").fulfilment, date: "2026-10-15" },
      }, "edited", at(TUESDAY, 12));

      const wed = await run(stores, h, at("2026-10-07", 6));
      const thu = await run(stores, h, at("2026-10-08", 6));
      const text = pdfText(h.sent[1]);

      assert.equal(wed.revised, 1);
      assert.equal(wed.slips, 1, "only the changed order is printed again");
      assert.match(h.sent[1].subject, /: 1 slip \(1 revised\)$/);
      assert.match(text, /\(REVISED\)/);
      assert.match(text, /\(Eggs, Large: was 2, now 5\)/);
      assert.match(text, /\(Removed: 1 \\327 Boneless Breasts/);
      assert.match(text, /\(Date: was Thursday, October 8, now Thursday, /);
      assert.match(text, /\(Packing slip\)/);
      assert.equal(thu.quiet, true);
    });

  it("names each kind of difference", () => {
    const before = snapshotOf(order("A"));
    const after = snapshotOf(order("A", {
      method: "onfarm", paid: false,
      customer: { name: "Pat Example", email: "new@example.com", phone: "" },
    }));
    const changes = changesBetween(before, after);

    assert.ok(changes.includes("Type: was Delivery, now On-farm pickup"));
    assert.ok(changes.some((c) => /^Window: was 10 AM – 4 PM, now /
      .test(c)));
    assert.ok(changes.includes("Contact details changed: see the new slip"));
    assert.ok(changes.includes("Total: was $37, now $32"));
    assert.ok(changes.includes("Payment: was PAID, now UNPAID ($32 due)"));
  });

  it("prints a CANCELLED sheet with no slip for a printed order",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, order("A"), placed);
      await saveOrder(stores, order("NEVER", { date: "2026-10-15" }), placed);
      await run(stores, h, at(TUESDAY, 6));
      // NEVER was printed too; a new one, placed and cancelled the same
      // day, never was and is left out.
      await saveOrder(stores, order("GHOST", { date: "2026-10-15" }), placed);
      await setStatus(stores, "A", "cancelled", at(TUESDAY, 10));
      await setStatus(stores, "GHOST", "cancelled", at(TUESDAY, 11));

      const wed = await run(stores, h, at("2026-10-07", 6));
      const text = pdfText(h.sent[1]);

      assert.equal(wed.cancelled, 1);
      assert.equal(wed.slips, 0);
      assert.match(h.sent[1].subject, /: No slips, 1 cancelled$/);
      assert.match(text, /\(CANCELLED\)/);
      assert.doesNotMatch(text, /\(Packing slip\)/);
      assert.doesNotMatch(text, /GHOST/);
      assert.equal((await readPrinted(stores)).get("A").snapshot.status,
        "cancelled");

      const thu = await run(stores, h, at("2026-10-08", 6));

      assert.equal(thu.quiet, true, "a cancellation is printed once");
    });

  it("says UNPAID, with what is due, for an order not paid in full",
    async () => {
      const stores = testStores();
      const h = harness();
      const owing = order("OWE", { method: "onfarm" });

      owing.payments[0].amount = 1000;
      await saveOrder(stores, owing, placed);
      await saveOrder(stores, order("OK", { method: "onfarm" }), placed);
      await run(stores, h, at(TUESDAY, 6));

      const text = pdfText(h.sent[0]);

      assert.deepEqual(paymentState(owing),
        { paid: false, due: 2200, refunded: 0 });
      assert.deepEqual(paymentState({ ...order("L"), status: "submitted" }),
        { paid: false, due: 3700, refunded: 0 }, "an old unpaid record");
      assert.match(text, /\(UNPAID\)/);
      assert.match(text, /\(\$22 due\)/);
      assert.match(text, /\(PAID\)/);
    });

  it("shows only the farm's refunds, not a change's", () => {
    // The customer took items out: the total fell from $37 to $12 and
    // the $25 difference went back.
    const edited = order("E", {
      lines: [{ sku: "EGG-L", label: "Eggs, Large", qty: 1, lineTotal: 7 }],
    });

    edited.totals = { ...edited.totals, subtotal: 700, total: 1200 };
    edited.payments[0].amount = 3700;
    edited.refunds = [
      { amount: 2500, status: "COMPLETED", edit: "edit-1" },
    ];
    assert.deepEqual(paymentState(edited),
      { paid: true, due: 0, refunded: 0 }, "the total already fell");

    // The farm then refunds $5 for a cracked egg.
    edited.refunds.push({ amount: 500, status: "COMPLETED" });
    edited.refunds.push({ amount: 900, status: "FAILED" });
    assert.deepEqual(paymentState(edited),
      { paid: true, due: 0, refunded: 500 }, "a failed one returned nothing");
  });

  it("mails a change to an order due today after the packet, once",
    async () => {
      const stores = testStores();
      const h = harness();
      const env = LIVE;
      const now = at("2026-10-08", 6);

      await saveOrder(stores, order("TODAY"), placed);
      await saveOrder(stores, order("LATER", { date: "2026-10-15" }), placed);
      // Before the packet nothing is mailed: the packet carries it.
      assert.deepEqual(await changedAfterPrint(stores, {
        env, mail: h.mail, now,
      }), []);
      await run(stores, h, now);

      // The farm's refund, and a change to a later order.
      await amendOrder(stores, "TODAY", {
        refunds: [{ amount: 700, status: "COMPLETED", at: now.toISOString() }],
      }, "refunded", at("2026-10-08", 9));
      await amendOrder(stores, "LATER", { notes: "Ring twice" }, "edited",
        at("2026-10-08", 9));

      const first = await changedAfterPrint(stores, {
        env, mail: h.mail, now: at("2026-10-08", 9, 15),
      });
      const second = await changedAfterPrint(stores, {
        env, mail: h.mail, now: at("2026-10-08", 9, 30),
      });
      const m = h.sent[1];

      assert.deepEqual(first, ["TODAY"], "LATER waits for tomorrow's packet");
      assert.deepEqual(second, []);
      assert.equal(m.subject, "Changed after printing: TODAY");
      // A partial refund is its own line: the order is still paid.
      assert.match(m.text, /Refunded: was \$0, now \$7/);
      assert.doesNotMatch(m.text, /UNPAID/);
      assert.doesNotMatch(pdfText(m), /\(UNPAID\)/);
      assert.match(pdfText(m), /\(Refunded\)/);
      assert.match(pdfText(m), /\(REVISED\)/);
      assert.doesNotMatch(pdfText(m), /Pick list/, "no cover for one order");
    });
});

describe("Healthchecks", () => {
  it("pings the check once the packet has gone, quiet days too",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, order("A"), placed);
      await run(stores, h, at(TUESDAY, 6));
      await run(stores, h, at("2026-10-07", 6));

      assert.deepEqual(h.pings.map((p) => [p.url, p.method]),
        [[URL, "GET"], [URL, "GET"]]);
    });

  it("scrubs the error it posts to /fail", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("A"), placed);
    await assert.rejects(run(stores, {
      ...h, mail: async () => {
        throw new Error("rejected pat@example.com, 401-555-0100");
      },
    }, at(TUESDAY, 6)));

    assert.doesNotMatch(h.pings[0].body, /pat@example\.com|555-0100/);
    assert.match(h.pings[0].body, /\[email:/);
  });

  it("pings /fail when the packet can't go, and tries again next run",
    async () => {
      const stores = testStores();
      const down = harness({ failMail: true });

      await saveOrder(stores, order("A"), placed);
      await assert.rejects(run(stores, down, at(TUESDAY, 6)), /Resend 503/);

      assert.equal(down.pings.length, 1);
      assert.equal(down.pings[0].url, `${URL}/fail`);
      assert.equal(down.pings[0].method, "POST");
      assert.match(down.pings[0].body, /Resend 503/);
      assert.doesNotMatch(down.pings[0].body, /pat@example|Pat Example/,
        "no customer data in the ping");
      assert.equal(await stores.jobs.get(`${SENT}${TUESDAY}`), null);
      assert.equal((await readPrinted(stores)).size, 0,
        "nothing counts as printed");

      const up = harness();
      const retry = await run(stores, up, at(TUESDAY, 6, 15));

      assert.equal(retry.slips, 1);
      assert.deepEqual(up.pings.map((p) => p.url), [URL]);
    });

  it("fails loudly when production sends without the key", async () => {
    const stores = testStores();
    const h = harness();
    const env = { ...FARM, MAIL_DRIVER: "resend" };

    await saveOrder(stores, order("A"), placed);
    await assert.rejects(run(stores, h, at(TUESDAY, 6), env),
      new RegExp(`${PING_KEY} is not set`));
    assert.equal(h.sent.length, 1, "the farm still gets its slips");

    // In the jobs run it is an error: the jobs check fails and the
    // developer is alerted.
    const jobs = testStores();
    const j = harness();

    await saveOrder(jobs, order("A"), placed);

    const report = await runJobs(jobs, {
      env: { ...env, DEV_NOTIFICATIONS_EMAIL: "dev@example.com",
        HEALTHCHECKS_JOBS_URL: "https://hc-ping.example/jobs" },
      mail: j.mail, fetchImpl: j.fetchImpl, now: at(TUESDAY, 6),
    });

    assert.deepEqual(report.errors.map((e) => e.step), ["packing"]);
    assert.ok(j.pings.some((p) => p.url === "https://hc-ping.example/jobs/fail"));
  });

  it("requires the key for a production build (check:env)", async () => {
    const { readFileSync } = await import("node:fs");
    const { readSample } = await import("../bin/env/sample.mjs");
    const { missingAtBuild } = await import("../bin/env/netlify.mjs");
    const sample = (env) => readSample(
      readFileSync(`.env.${env}.sample`, "utf8"), env);

    assert.ok(missingAtBuild(sample("production"), {}).includes(PING_KEY));
    assert.ok(!sample("staging").keys.includes(PING_KEY),
      "staging has no packing check");
  });

  it("never pings from staging, even with a URL set", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("A"), placed);
    await run(stores, h, at(TUESDAY, 6), {
      ...FARM, SITE_CONTEXT: "staging", MAIL_DRIVER: "outbox", [PING_KEY]: URL,
    });

    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.pings, []);
  });
});

describe("the mail seam's attachments", () => {
  const message = {
    to: "farm@example.com", subject: "Slips", text: "t", html: "<p>t</p>",
    attachments: [{
      filename: "p.pdf", contentType: "application/pdf",
      content: Buffer.from("%PDF").toString("base64"),
    }],
  };

  it("hands them to Resend", async () => {
    let body;
    const fetchImpl = async (url, init) => {
      body = JSON.parse(init.body);

      return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
    };

    await sendMail(message, {
      env: { MAIL_DRIVER: "resend", RESEND_API_KEY: "re_test",
        MAIL_FROM: "Farm <o@example.com>" },
      fetchImpl,
    });
    assert.deepEqual(body.attachments, [{
      filename: "p.pdf", content: "JVBERg==", "content_type": "application/pdf",
    }]);
  });

  it("keeps them in the staging outbox", async () => {
    const stores = testStores();

    await sendMail(message, { env: { MAIL_DRIVER: "outbox" }, stores });

    const [{ key }] = await stores.jobs.list(OUTBOX_PREFIX);

    assert.deepEqual((await stores.jobs.get(key)).attachments,
      message.attachments);
  });
});

describe("scheduled pickups in a packet", () => {
  const sched = (id, occurrence, date, over = {}) => order(id, {
    method: "scheduled", date,
    fulfilment: { method: "scheduled", occurrence, date, onfarm: null,
      delivery: null },
    ...over,
  });

  it("stacks each occurrence together, and slips name it", async () => {
    const entries = choose({
      open: [
        sched("M2", "WAC5-261025", "2026-10-25"),
        sched("D1", "VFVQ-261017", "2026-10-17"),
        order("F", { method: "onfarm", date: "2026-10-17" }),
        sched("M1", "WAC5-261025", "2026-10-25"),
        sched("D2", "VFVQ-261017", "2026-10-17"),
      ],
      printed: new Map(), gone: [], day: TUESDAY,
    });

    assert.deepEqual(entries.map((e) => e.order.id),
      ["D1", "D2", "F", "M1", "M2"]);

    const text = packetPdf({ entries, now: at(TUESDAY, 6), title: "T" })
      .toString("latin1");

    assert.ok(text.includes("Foster Farmers Market"), "the series' name");
    assert.ok(text.includes("Shady Acres Diner"), "its place");
    assert.ok(text.includes("(Packing slip)"));
  });

  it("names the old and new occurrence of a move", () => {
    const was = snapshotOf(sched("A", "VFVQ-261017", "2026-10-17"));
    const now = snapshotOf(sched("A", "WAC5-261025", "2026-10-25"));
    const changes = changesBetween(was, now);

    assert.ok(changes.includes("Pickup: was Drop site, now Foster " +
      "Farmers Market"), changes.join("; "));
    assert.ok(!changes.some((c) => /^Type:/.test(c)));
  });

  it("reads a renamed series or a migrated method as unchanged", async () => {
    const stores = testStores();
    const h = harness();
    const a = sched("A", "VFVQ-261017", "2026-10-17");

    await saveOrder(stores, a, placed);
    await run(stores, h, at(TUESDAY, 6));

    const printed = await readPrinted(stores);
    const old = { ...printed.get("A").snapshot, name: "Old name",
      method: "scituate" };
    const entries = choose({
      open: [a], printed: new Map([["A", { snapshot: old }]]),
      gone: [], day: TUESDAY,
    });

    assert.deepEqual(entries, []);
  });

  it("does not read a snapshot from before the occurrence as changed",
    async () => {
      const stores = testStores();
      const h = harness();
      const a = sched("A", "VFVQ-261017", "2026-10-17");

      await saveOrder(stores, a, placed);
      await run(stores, h, at(TUESDAY, 6));

      const printed = await readPrinted(stores);
      const old = { ...printed.get("A").snapshot };

      delete old.occurrence;
      delete old.name;

      const entries = choose({
        open: [a], printed: new Map([["A", { snapshot: old }]]),
        gone: [], day: TUESDAY,
      });

      assert.deepEqual(entries, []);
    });

  it("names the occurrence on a cancelled sheet", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, sched("A", "WAC5-261025", "2026-10-25"), placed);
    await run(stores, h, at(TUESDAY, 6));
    await setStatus(stores, "A", "cancelled", at(TUESDAY, 10));
    await run(stores, h, at("2026-10-07", 6));

    const text = pdfText(h.sent[1]);

    assert.match(text, /\(CANCELLED\)/);
    assert.ok(text.includes("Foster Farmers Market"));
    assert.ok(!text.includes("undefined"));
  });

  it("groups the email's list by occurrence", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, sched("A", "VFVQ-261017", "2026-10-17"), placed);
    await saveOrder(stores, sched("B", "WAC5-261025", "2026-10-25"), placed);
    await saveOrder(stores, order("C", { date: "2026-10-08" }), placed);
    await run(stores, h, at(TUESDAY, 6));

    const { text } = h.sent[0];

    assert.match(text, /\*\*Delivery, Thursday, October 8\*\*\n- \*\*C/);
    assert.match(text, /\*\*Drop site, Saturday, October 17, Village Green/);
    assert.match(text, /\*\*Foster Farmers Market, Sunday, October 25, Shady/);
    assert.match(text, /9 AM – 1 PM\*\*\n- \*\*B\*\*/);
    assert.doesNotMatch(text, /Market pickup/);
  });
});

describe("the library's sample packet", () => {
  it("builds from fake orders, every kind of sheet", () => {
    const { entries, now } = samplePacket();
    const text = packetPdf({ entries, now, title: "Sample" })
      .toString("latin1");

    assert.deepEqual(entries.map((e) => e.kind).sort(),
      ["cancelled", "changed", "new", "new", "new", "new"]);
    for (const word of ["(PAID)", "(UNPAID)", "(REVISED)", "(CANCELLED)",
      "(Pick list)"]) {
      assert.ok(text.includes(word), word);
    }
    assert.ok(entries.every((e) => !e.order.customer
      || e.order.customer.email.endsWith("@example.com")), "fake people");
  });
});

describe("when the packet goes, and going once", () => {
  it("gives an unpaid order a slip, marked UNPAID with what is due",
    async () => {
      const stores = testStores();
      const h = harness();

      await saveOrder(stores, {
        ...order("OLD", { paid: false }), status: "submitted",
      }, placed);

      const r = await run(stores, h, at(TUESDAY, 6));
      const text = pdfText(h.sent[0]);

      assert.equal(r.slips, 1);
      assert.match(text, /\(UNPAID\)/);
      assert.match(text, /\(\$37 due\)/);
    });

  it("waits for the next morning when it starts after 10:00", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("A", { date: "2026-10-15" }), placed);

    // The release lands mid-afternoon: nothing until 6:00 tomorrow.
    assert.equal(await run(stores, h, at(TUESDAY, 14, 30)), null);
    assert.equal(await run(stores, h, at("2026-10-07", 5, 45)), null);
    assert.equal((await run(stores, h, at("2026-10-07", 6))).slips, 1);
    assert.equal(h.sent.length, 1);
  });

  it("retries with the same orders and the same body", async () => {
    const stores = testStores();
    const lost = harness({ failMail: true });
    const h = harness();
    let firstBody = null;

    await saveOrder(stores, order("A"), placed);
    await assert.rejects(run(stores, {
      ...lost, mail: async (m) => {
        firstBody = m;
        throw new Error("timed out");
      },
    }, at(TUESDAY, 6)));
    assert.ok(await stores.jobs.get(`${PENDING}${TUESDAY}`));

    // A failed try after 10:00 still retries; a new order waits.
    await saveOrder(stores, order("B"), placed);
    await run(stores, h, at(TUESDAY, 11));

    const m = h.sent[0];

    assert.equal(m.idempotencyKey, firstBody.idempotencyKey);
    assert.equal(m.subject, firstBody.subject);
    assert.equal(m.text, firstBody.text);
    assert.equal(m.attachments[0].content, firstBody.attachments[0].content,
      "the same PDF, stamped with the first try's time");
    assert.equal(await stores.jobs.get(`${PENDING}${TUESDAY}`), null);
    assert.ok(!(await readPrinted(stores)).has("B"), "B waits for tomorrow");
    assert.equal((await run(stores, h, at("2026-10-07", 6))).slips, 1);
  });

  it("counts Resend's refusal of a resent key as sent", async () => {
    const stores = testStores();
    const h = harness();

    await saveOrder(stores, order("A"), placed);
    await assert.rejects(run(stores, harness({ failMail: true }),
      at(TUESDAY, 6)));
    // A went out on that try after all; then it changed.
    await amendOrder(stores, "A", { notes: "Ring twice" }, "edited",
      at(TUESDAY, 6, 5));

    const r = await run(stores, {
      ...h, mail: async () => {
        throw new MailError("Resend 409", {
          status: 409, detail: { name: "invalid_idempotent_request" },
        });
      },
    }, at(TUESDAY, 6, 15));

    assert.equal(r.slips, 1);
    assert.ok(await stores.jobs.get(`${SENT}${TUESDAY}`));
    assert.deepEqual(h.pings.map((p) => p.url), [URL]);

    // What was printed is the first try's A, so the change shows.
    const wed = await run(stores, h, at("2026-10-07", 6));

    assert.equal(wed.revised, 1);
  });
});
