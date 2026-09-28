// Every email the farm sends, as pure functions of the record they
// describe. Each returns { subject, text, html }. The text version is
// the source; the HTML wraps the same lines in the site's look (the
// wordmark, a card, the green buttons) and prints the same words.
//
// The wording is James's, from his review of 2026-09-22 (each email
// rewritten in full; the replies are kept in
// .ignored/review-replies-2026-09-22.json). The shape he set: a
// greeting, the one sentence that matters in bold, the button, an
// "Order details" block that names the order, the lines without
// prices, and where and when; then the links; then a footer row.
//
// `links` is mailLinks(env) from site.mjs: { orders, contact, admin,
// order }. Any of them may be null (accounts off, no admin URL) and
// the row leaves it out.

import terms from "../../../data/delivery.json" with { type: "json" };
import {
  pickupTimes, windowLabel,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, label, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { GUIDE, RUNBOOK_ALERTS } from "./alerts-guide.mjs";
import { company } from "./company.mjs";
import { between, methodName } from "./describe.mjs";
import { keptFee, paymentsOf } from "./records.mjs";

const escape = (s) => String(s)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// The two marks James writes with: **bold** and _**bold italic**_.
// The text keeps them; the HTML turns them into tags.
const inline = (s) => escape(s)
  .replace(/_\*\*(.+?)\*\*_/g, "<em><strong>$1</strong></em>")
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

// Accepts a customer record (firstName preferred) or a bare name.
const firstName = (who) => {
  if (who && typeof who === "object") {
    return who.firstName || firstName(who.name);
  }

  return String(who || "").trim().split(/\s+/)[0] || "";
};

// Blocks: text and HTML at once.
const p = (text) => ({ text, html: `<p>${inline(text)}</p>` });
const heading = (text) => ({
  text: `\n${text}`,
  html: `<h3 style="margin:24px 0 8px;font-size:16px">${escape(text)}</h3>`,
});
// The site's .btn-primary and .btn-outline-primary, inlined.
const BTN = "display:inline-block;padding:8px 16px;border-radius:4px;" +
  "font-weight:bold;line-height:1.5;text-decoration:none;";
const button = (text, url, { outline = false, tone = "primary" } = {}) => {
  const color = tone === "secondary" ? MUTED : GREEN;
  const look = outline
    ? `border:1px solid ${color};color:${color};background:#fff`
    : `border:1px solid ${GREEN};color:#fff;background:${GREEN}`;

  return {
    text: `${text}: ${url}`,
    html: `<p style="margin:20px 0"><a href="${escape(url)}" ` +
      `style="${BTN}${look}">${escape(text)}</a></p>`,
  };
};
const list = (items) => ({
  text: items.map((i) => `- ${i}`).join("\n"),
  html: `<ul>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`,
});
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

// A cell or list item is a string, or { text, html } when it needs
// its own markup.
const rich = (c) => (c && typeof c === "object"
  ? c : { text: String(c), html: inline(String(c)) });

// An identifier the farm will paste somewhere: monospace, selected
// whole by one click (user-select: all, which Apple Mail honours).
const mono = (text) => ({
  text,
  html: `<span style="font-family:${MONO};font-size:14px;` +
    `-webkit-user-select:all;user-select:all">${escape(text)}</span>`,
});

// A small table: aligned columns in text, a plain <table> in HTML that
// scrolls sideways inside the card when its columns need the room.
// `align` is per column: left (the default), right or center.
const CELL = "padding:4px 14px 4px 0;vertical-align:top;white-space:nowrap";
const table = (headers, rows, { align = [] } = {}) => {
  const cells = rows.map((r) => r.map(rich));
  const widths = headers.map((h, i) => Math.max(
    h.length, ...cells.map((r) => r[i].text.length)
  ));
  const pad = (s, i) => (align[i] === "right"
    ? s.padStart(widths[i]) : s.padEnd(widths[i]));
  const line = (arr) => arr.map(pad).join("  ").trimEnd();
  const cell = (tag, html, i, extra = "") =>
    `<${tag} style="${CELL};text-align:${align[i] || "left"}${extra}">${
      html}</${tag}>`;

  return {
    text: [line(headers), ...cells.map((r) => line(r.map((c) => c.text)))]
      .join("\n"),
    html: `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;` +
      `margin:12px 0"><table style="border-collapse:collapse;` +
      `font-size:16px"><thead><tr>${headers.map((h, i) =>
        cell("th", escape(h), i, ";border-bottom:1px solid rgba(0,0,0,.175)"))
        .join("")}</tr></thead><tbody>${cells.map((r) =>
        `<tr>${r.map((c, i) => cell("td", c.html, i)).join("")}</tr>`)
        .join("")}</tbody></table></div>`,
  };
};
// A list whose items may carry markup ({ text, html }) or a child
// list ({ text, children: [string] }). Child lists sit close under
// their parent, indented half the usual amount.
const treeText = (i) => {
  if (typeof i === "string") return `- ${i}`;
  if (!i.children) return `- ${i.text}`;

  return [`- ${i.text}`, ...i.children.map((c) => `  - ${c}`)].join("\n");
};
const treeHtml = (i) => {
  if (typeof i === "string") return `<li>${inline(i)}</li>`;
  if (!i.children) return `<li>${i.html}</li>`;

  return `<li>${inline(i.text)}<ul style="margin:2px 0 4px;` +
    `padding-left:1.25em">${i.children.map((c) => `<li>${inline(c)}</li>`)
      .join("")}</ul></li>`;
};
const tree = (items) => ({
  text: items.map(treeText).join("\n"),
  html: `<ul>${items.map(treeHtml).join("")}</ul>`,
});
// A command for the farm to run: monospace, the whole string selected
// by one click, wrapped rather than clipped. In text it stands on its
// own indented line.
const command = (cmd) => ({
  text: `\n    ${cmd}\n`,
  html: `<pre style="margin:8px 0 14px;padding:8px 12px;border-radius:4px;` +
    `background:#f3f5f4;font-family:${MONO};font-size:14px;` +
    `line-height:1.5;white-space:pre-wrap;word-break:break-all;` +
    `-webkit-user-select:all;user-select:all">${escape(cmd)}</pre>`,
});
// "Your orders | Contact us": the links that end a message. Pairs
// with a null URL are left out.
const row = (pairs) => {
  const kept = pairs.filter(([, url]) => url);

  return {
    text: `\n${kept.map(([t, u]) => `${t}: ${u}`).join("\n")}`,
    html: `<p style="margin:24px 0 0">${kept.map(([t, u]) =>
      `<a href="${escape(u)}" style="color:${GREEN}">${escape(t)}</a>`)
      .join(" | ")}</p>`,
  };
};

// The site's look, inlined: Aller (served from the site, with the
// system stack behind it), the wordmark in the header's green, cards
// with the account page's border, radius and shadow. The <style>
// block does what inline styles cannot: load the font and stop iOS
// Mail restyling the address and phone in the footer as blue links.
const GREEN = "#186243"; // $primary: the brand green, shaded 20%.
const INK = "#161a1e"; // $gray-900, the body text.
const MUTED = "#5e5e5f"; // $gray-600.
const FONT = "Aller,system-ui,-apple-system,'Segoe UI',Roboto," +
  "'Helvetica Neue',Arial,sans-serif";

const styles = (site) => `<style>${site ? `
@font-face{font-family:Aller;font-weight:normal;font-style:normal;
src:url("${site}/fonts/aller-regular.woff2") format("woff2")}
@font-face{font-family:Aller;font-weight:bold;font-style:normal;
src:url("${site}/fonts/aller-bold.woff2") format("woff2")}
@font-face{font-family:Aller;font-weight:bold;font-style:italic;
src:url("${site}/fonts/aller-bold-italic.woff2") format("woff2")}` : ""}
a[x-apple-data-detectors]{color:inherit!important;
text-decoration:none!important;font-size:inherit!important;
font-family:inherit!important;font-weight:inherit!important;
line-height:inherit!important}
u+#body a{color:inherit;text-decoration:none}
</style>`;

const header = (site) => (site
  ? `<p style="margin:0 0 20px;text-align:center"><img ` +
    `src="${site}/images/email/logo.png" width="280" ` +
    `alt="${escape(company.name)}" style="display:block;margin:0 auto;` +
    `width:280px;max-width:100%;height:auto;border:0"></p>`
  : `<p style="margin:0 0 20px;font-size:13px;font-weight:bold;` +
    `letter-spacing:.08em;text-transform:uppercase;color:${GREEN}">` +
    `${escape(company.name)}</p>`);

// Centred, the four lines James asked for.
const footerLines = [
  company.name,
  `${company.address.short || company.address.street}, ` +
    `${company.address.city}, ${company.address.state} ` +
    `${company.address.zip}`,
  company.email,
  company.phone && company.phone.display,
].filter(Boolean);
const footer = {
  text: footerLines.join("\n"),
  html: `<p style="margin:20px 0 0;font-size:13px;line-height:1.6;` +
    `text-align:center;color:${MUTED}">${
      footerLines.map(escape).join("<br>")}</p>`,
};

// The subject is the title; the body does not repeat it. A farm email
// carries a `tag`, a small gray capital line at the top of the card
// naming the kind of message, so the inbox reads at a glance.
const render = (title, blocks, links = {}, { tag = null } = {}) => {
  const tagged = tag
    ? [{
      text: tag.toUpperCase(),
      html: `<p style="margin:0 0 12px;font-size:12px;font-weight:bold;` +
        `letter-spacing:.12em;text-transform:uppercase;color:${MUTED}">${
          escape(tag)}</p>`,
    }, ...blocks]
    : blocks;
  const text = [title, "", ...tagged.map((b) => b.text), "", footer.text]
    .join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width">` +
    // Safari, and the staging outbox in it, would link the footer's
    // phone number and paint it blue; iOS Mail is held off by the
    // x-apple-data-detectors rule in the <style> block.
    `<meta name="format-detection" ` +
    `content="telephone=no, date=no, address=no, email=no">` +
    `<meta name="color-scheme" content="light">` +
    `<meta name="supported-color-schemes" content="light">` +
    `<title>${escape(title)}</title>${styles(links.site)}</head>` +
    `<body id="body" style="margin:0;padding:0;background:#fff;` +
    `font-family:${FONT};font-size:16px;color:${INK};line-height:1.63">` +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px">` +
    `${header(links.site)}` +
    `<div style="background:#fff;border:1px solid rgba(0,0,0,.175);` +
    `border-radius:5px;padding:20px 24px;` +
    `box-shadow:0 2px 3px rgba(7,6,6,.2)">${
      tagged.map((b) => b.html).join("")
    }</div>${footer.html}</div></body></html>`;

  return { text, html };
};

const contactUrl = (links) =>
  (links && links.contact) || `mailto:${company.email}`;

// The row every customer email ends on.
const customerFooter = (links = {}) => row([
  ["Your orders", links.orders], ["Contact us", contactUrl(links)],
]);

const adminFooter = (links = {}) => row([["Admin", links.admin]]);

// The payment's own receipt (Square's, or Venmo's) carries the money,
// so customer messages list what was ordered without pricing it.
const lines = (order, { prices = false } = {}) => list(order.lines.map(
  (l) => `${l.qty} × ${l.label}${
    prices ? ` (${dollars(l.lineTotal * 100)})` : ""}`
));

// What a change took out of an order, as "1 × Sausage" lines: a line
// dropped whole, or the part of one that went down. `before` is the
// edit's record of the order as it was. James (T4, #192): removals sit
// in their own group at the top of every email that lists a change,
// never "0 ×" or a struck-through or muted line, since an email client
// may strip the styling.
const removedGroup = (order, before) => {
  const now = new Map(order.lines.map((l) => [l.sku, l.qty]));
  const gone = before.lines
    .map((l) => ({ ...l, qty: l.qty - (now.get(l.sku) || 0) }))
    .filter((l) => l.qty > 0)
    .map((l) => `${l.qty} × ${l.label}`);

  return gone.length ? [heading("Removed"), list(gone)] : [];
};

// The lines of an order a customer changed: what was removed first,
// then the order as it stands, an increase marked "3 × Eggs (1 added)".
const changedLines = (order, before) => {
  const was = new Map(before.lines.map((l) => [l.sku, l.qty]));
  const removed = removedGroup(order, before);
  const current = list(order.lines.map((l) => {
    const d = l.qty - (was.get(l.sku) || 0);

    return `${l.qty} × ${l.label}${d > 0 ? ` (${d} added)` : ""}`;
  }));

  return removed.length
    ? [...removed, heading("Your order now"), current]
    : [current];
};

// `total` follows the Total line: "(was $94, you paid $7 more)".
const totalsBlock = (order, { total = "" } = {}) => {
  const t = order.totals;
  const items = [`Subtotal ${dollars(t.subtotal)}`];

  if (t.discountAmount) {
    items.push(
      `${t.discountLabel || "Discount"} −${dollars(t.discountAmount)}`
    );
  }
  if (order.fulfilment.method === "delivery") {
    const base = t.deliveryFee - (t.areaFee || 0);

    items.push(base ? `Delivery fee +${dollars(base)}` : "Delivery fee waived");
    if (t.areaFee) items.push(`Outside-area fee +${dollars(t.areaFee)}`);
  }
  items.push(`Total ${dollars(t.total)}${total ? ` ${total}` : ""}`);

  return list(items);
};

// The order number: a plain line by default; `copyable` sets it the
// way a one-time code is shown, large, spaced, monospace, selected
// whole by one click, for whoever has to paste it somewhere (the farm
// into a command, a customer into a Venmo note).
const orderNumber = (order, {
  copyable = false, label = "Order number",
} = {}) => (copyable
  ? {
    text: `${label}: **${order.id}**`,
    html: `<p style="margin:12px 0 4px;font-size:13px;color:${MUTED}">` +
      `${escape(label)}</p><p style="margin:0 0 12px"><span style="` +
      `display:inline-block;padding:6px 12px;border:1px solid ` +
      `rgba(0,0,0,.175);border-radius:4px;background:#f3f5f4;` +
      `font-family:${MONO};font-size:20px;letter-spacing:.06em;` +
      `-webkit-user-select:all;user-select:all">${escape(order.id)}</span></p>`,
  }
  : p(`${label}: **${order.id}**`));

// "9 – 11 AM", "11 AM – 1 PM": a range the farm confirmed before W11d,
// on the hour.
const hoursRange = (from, to) => {
  const h = (x) => `${((x + 11) % 12) + 1}`;
  const m = (x) => (x < 12 ? "AM" : "PM");

  return m(from) === m(to)
    ? `${h(from)} – ${h(to)} ${m(to)}`
    : `${h(from)} ${m(from)} – ${h(to)} ${m(to)}`;
};

// "9 AM – noon": the window booked. A record from before W11d may
// carry the range the farm confirmed inside its window; that wins.
const pickupWindow = (order) => {
  const o = order.fulfilment.onfarm || {};
  const times = pickupTimes(o);

  if (o.confirmed) return hoursRange(o.confirmed.from, o.confirmed.to);

  return times ? windowLabel(times) : String(o.window || "");
};

// "84 Foster Center Rd, Foster, RI 02825", skipping whatever the
// record lacks.
const streetAddress = (a = {}) => [
  a.address1, a.address2, a.town,
  [a.state, a.zip].filter(Boolean).join(" "),
].filter(Boolean).join(", ");

// "Order type: Delivery" and the two lines under it.
const orderType = (order) => {
  const f = order.fulfilment;
  const when = label(f.date);
  const items = f.method === "delivery"
    ? [
      `Arrives: ${when}, between ${between(terms.delivery.window)}`,
      `Address: ${streetAddress(f.delivery)}`,
    ]
    : f.method === "scituate"
      ? [
        `When: ${when}, between ${between(terms.scituate.window)}`,
        `Where: ${terms.scituate.location}`,
      ]
      : [
        `When: ${when}, ${pickupWindow(order)}`,
        `Where: ${terms.onFarm.address}`,
      ];

  return [p(`Order type: **${methodName(f.method)}**`), list(items)];
};

// The pickup window for a labelled line: "Thursday, October 8,
// 9 AM – noon".
const windowPhrase = (order) =>
  `${label(order.fulfilment.date)}, ${pickupWindow(order)}`;

// The block that names the order, in every customer email about one.
const orderDetails = (order) => [
  heading("Order details"),
  orderNumber(order),
  lines(order),
  ...orderType(order),
];

// The customer's own instructions, as one line.
const instructions = (order) => {
  const d = order.fulfilment.delivery || {};
  const notes = [d.notes, order.notes].filter(Boolean)
    .map((n) => String(n).trim().replace(/[.!?]?$/, "."));

  return notes.join(" ");
};

// Sent when the order is paid, which books every way to get it,
// pickup times included (W11d). Square sends the receipt, so this one
// does not price anything either.
export const orderConfirmed = (order, { orderUrl, links } = {}) => {
  const title = "Your order is confirmed";
  const total = dollars(order.totals.total);
  const blocks = [
    order.fulfilment.method === "onfarm"
      ? p(`Thanks, ${firstName(order.customer)}. Your payment of ${total} ` +
        "came through and your pickup time is set, so your order is " +
        "confirmed.")
      : p(`Thanks, ${firstName(order.customer)}. Your payment of ${total} ` +
        "came through and your order is confirmed."),
    ...orderDetails(order),
  ];

  if (orderUrl) {
    blocks.push(button("View or edit this order", orderUrl));
    if (order.fulfilment.method === "onfarm") {
      blocks.push(button("Reschedule pickup", orderUrl, { outline: true }));
    }
  }
  blocks.push(customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// Wednesday night, for every paid delivery going out tomorrow.
export const deliveryReminder = (order, {
  orderUrl, settingsUrl, links,
} = {}) => {
  const d = order.fulfilment.delivery || {};
  const title = "Your delivery is tomorrow";
  const notes = instructions(order);
  const blocks = [
    p("Tomorrow is delivery day! Your order will arrive between " +
      `${between(terms.delivery.window)}.`),
    p("Please remember to:"),
    list([
      "Leave your cooler with ice outside in the morning",
      "Provide gate or door codes, if needed",
    ]),
    p(`We'll look for your cooler here: _**${
      d.cooler || "wherever you told us"}.**_`),
  ];

  if (d.gate) blocks.push(p(`Gate or door code you gave us: _**${d.gate}**_`));
  if (notes) blocks.push(p(`Your notes and instructions: _**${notes}**_`));
  blocks.push(...orderDetails(order));
  if (orderUrl) blocks.push(button("View or edit this order", orderUrl));
  if (settingsUrl) {
    blocks.push(button("Turn off delivery reminders", settingsUrl,
      { outline: true, tone: "secondary" }));
  }
  blocks.push(customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// After a customer changes the date, the details or the items of an
// order. `difference` (cents) is set when the items changed: what they
// paid more, or what went back, and the new totals. `before` is the
// edit's record of the order as it was, which marks each line.
export const orderChanged = (order, {
  orderUrl, links, difference = null, before = null,
} = {}) => {
  const title = "Your order is updated";
  const f = order.fulfilment;
  const notes = instructions(order);
  const blocks = [
    p(`${firstName(order.customer)}, your order has been updated.`),
    orderNumber(order),
    ...(before ? changedLines(order, before) : [lines(order)]),
  ];

  if (difference !== null) {
    const was = before ? [`was ${dollars(before.totals.total)}`] : [];

    if (difference > 0) {
      was.push(`you paid ${dollars(difference)} more`);
    } else if (difference < 0) {
      was.push(`you were refunded ${dollars(-difference)}`);
    }
    blocks.push(totalsBlock(order, {
      total: was.length ? `(${was.join(", ")})` : "",
    }));
    if (difference < 0) {
      blocks.push(p("Your refund can take a few days to reach you."));
    }
  }
  blocks.push(...orderType(order));

  if (f.method === "delivery" && f.delivery) {
    blocks.push(p(`Where will we find your cooler? _**${
      f.delivery.cooler || "you haven't said"}**_`));
    if (f.delivery.gate) {
      blocks.push(p(`Gate or door code: _**${f.delivery.gate}**_`));
    }
  }
  if (notes) blocks.push(p(`Other notes or instructions: _**${notes}**_`));
  if (orderUrl) blocks.push(button("View or edit this order", orderUrl));
  blocks.push(customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// "October 15": the drafts name the weekday themselves.
const dayAfter = (iso, days) => label(addDays(iso, days)).replace(/^\w+, /, "");

// A customer's delivery the farm could not leave (#193), held seven
// days for them to choose (C8). The fee the attempt kept decides the
// wording: kept, the customer is warned before choosing that it stays
// whatever they choose; waived, everything comes back (James, C3). A
// farm or weather miss gets movedDelivery instead (C7). Policy-pages'
// drafts of 2026-09-28, to approve; nothing sends this yet.

// What we saw, not what the customer did (C6a, James's drafts).
const missedReason = (order) => {
  const a = order.attempted || {};
  const d = order.fulfilment.delivery || {};
  const where = [d.address1, d.town].filter(Boolean).join(", ");
  const unreached = "and we couldn't reach you by phone, text or the " +
    "doorbell";

  if (a.cause === "no-access") {
    return "we couldn't get to where you asked us to leave it" +
      `${a.detail ? ` (${a.detail})` : ""}, ${unreached}`;
  }
  if (a.cause === "no-address") {
    return `we couldn't find your address as you gave it (${where}), ` +
      "and we couldn't reach you";
  }
  if (a.cause === "no-cooler" && d.cooler) {
    return `we didn't find a cooler where you told us (${d.cooler}), ${
      unreached}`;
  }

  // F1's line, for no-cooler without a place and for an attempt
  // recorded before the causes.
  return "there was no cooler out, and we couldn't reach you";
};

export const missedDelivery = (order, { pickUrl, links } = {}) => {
  const title = "We couldn't deliver your order";
  const fee = keptFee(order);
  const next = dayAfter(order.fulfilment.date, 7);
  const hold = label(addDays(order.fulfilment.date, 7));
  const items = dollars(order.totals.total - fee);
  const blocks = [
    p(`Hi ${firstName(order.customer)},`),
    p("We came by today with your order but couldn't leave it: " +
      `${missedReason(order)}. Your order is back at the farm.`),
  ];

  if (fee) {
    blocks.push(
      p("Please choose what you'd like us to do:"),
      list([
        `Deliver it next Thursday, ${next}, for another delivery fee ` +
          `of ${dollars(fee)}`,
        "Have it ready for pickup at the farm or the drop site, at no " +
          "charge",
        `Cancel it, and we'll refund ${items} for your items`,
      ]),
      p(`Today's delivery fee of ${dollars(fee)} isn't refunded, ` +
        "whichever you choose."),
      p(`We'll hold your order until ${hold}. If you haven't chosen by ` +
        `then, we'll cancel it and refund ${items} for your items.`)
    );
  } else {
    blocks.push(
      p("Please choose what you'd like us to do:"),
      list([
        `Deliver it next Thursday, ${next}, at no extra charge`,
        "Have it ready for pickup at the farm or the drop site",
        `Cancel it for a full refund of ${dollars(order.totals.total)}`,
      ]),
      p(`We'll hold your order until ${hold}. If you haven't chosen by ` +
        "then, we'll cancel it and refund it in full.")
    );
  }
  if (pickUrl) blocks.push(button("Reschedule or cancel", pickUrl));
  blocks.push(...orderDetails(order), customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// Our own miss or the weather's (C7): no fee, no choice asked for. We
// have moved it to next Thursday; they may pick otherwise. Policy-pages'
// draft of 2026-09-28, to approve; nothing sends this yet.
export const movedDelivery = (order, { pickUrl, links } = {}) => {
  const title = "Your delivery is moved to next Thursday";
  const why = order.attempted && order.attempted.cause === "weather"
    ? "The weather kept us from delivering your order today"
    : "We weren't able to deliver your order today";
  const blocks = [
    p(`Hi ${firstName(order.customer)},`),
    p(`${why}, so we've moved your delivery to next Thursday, ${
      dayAfter(order.fulfilment.date, 7)}. You don't need to do anything.`),
    p("If next Thursday doesn't suit you, you can choose another day, " +
      "pick up at the farm or the drop site, or cancel for a full refund " +
      `of ${dollars(order.totals.total)}, delivery fee included.`),
  ];

  if (pickUrl) blocks.push(button("Reschedule or cancel", pickUrl));
  blocks.push(...orderDetails(order), customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// Why the farm cancelled (T2a, James's list of 2026-09-28): the
// customer always gets a sentence written in advance, never one typed
// in a hurry. The keys are `bin/nff orders cancel --reason`; anything
// else is `--reason-text`. A customer we won't serve gets no reason by
// email (T2b); James writes to them himself. A site bug is "mistake"
// (T2c).
export const CANCEL_REASONS = {
  "sold-out": () => "Something in your order sold out before our stock " +
    "count caught up. We're sorry we didn't catch it before you placed " +
    "your order.",
  delay: (order) => "We couldn't get your order ready in time for " +
    `${label(order.fulfilment.date)}.`,
  weather: (order) => `For everyone's safety, we won't ${
    order.fulfilment.method === "delivery" ? "deliver" : "open for pickup"
  } on ${label(order.fulfilment.date)} due to severe weather.`,
  emergency: () => "Something urgent came up on the farm that needs us " +
    "that day.",
  mistake: () => "We made a mistake with your order so we had to cancel " +
    "it. We're sorry we didn't catch it before you placed your order.",
};

// After a cancellation: always a notice of the money that went back
// (T1a), since an order is only placed once it is paid. `by` is who
// ended it: "farm", "customer" or "hold" (the seven-day hold after a
// miss ran out, C8). `refunded`, in cents, is what this cancellation
// sends back: the items only when a missed delivery kept its fee.
// `refundedOn` (ISO) says it went back earlier instead. The farm's
// `reason` (a CANCEL_REASONS key) or `reasonText` is its one line why.
export const orderCancelled = (order, {
  by = "farm", refunded = 0, refundedOn = null, reason = null,
  reasonText = "", links,
} = {}) => {
  const title = "Your order is cancelled";
  const blocks = [p(`Hi ${firstName(order.customer)},`)];
  const fee = keptFee(order);
  const cancelled = `We cancelled your order for ${
    methodName(order.fulfilment.method).toLowerCase()} on ${
    label(order.fulfilment.date)}`;

  if (by === "hold") {
    blocks.push(p("We held your order for seven days and didn't hear " +
      "from you, so we've cancelled it."));
  } else if (by === "customer") {
    // After a missed delivery the miss prompted it, so no "as
    // requested" (C4, 2A and 2B).
    blocks.push(p(order.attempted ? `${cancelled}.` : `${cancelled}, ` +
      "as requested."));
  } else {
    blocks.push(p(`${cancelled}.`));

    const why = CANCEL_REASONS[reason]
      ? CANCEL_REASONS[reason](order)
      : String(reasonText || "").trim();

    if (why) blocks.push(p(why));
  }

  if (refunded > 0) {
    blocks.push(p(refundedOn
      ? `**We refunded ${dollars(refunded)} on ${
        label(today(new Date(refundedOn), terms.timeZone))}.**`
      : `**A refund of ${dollars(refunded)} is on its way.**`));
    if (fee) {
      blocks.push(p(`The delivery fee of ${dollars(fee)} isn't refunded ` +
        "because we made the trip."));
    }
    blocks.push(p("Most refunds arrive within a few business days."));
  }
  blocks.push(orderNumber(order), customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// The farm decided on an address outside the usual area.
export const addressDecision = (customer, decision, { links } = {}) => {
  const a = customer.address || {};
  const where = `${a.address1 || ""}, ${a.town || ""} ${a.zip || ""}`.trim();
  const approved = decision === "approved";
  const title = approved
    ? "We can deliver to your address"
    : "We can't deliver to your address";
  const blocks = [p(`Hi ${firstName(customer)},`)];

  if (approved) {
    blocks.push(p(`Good news! We can deliver to you at ${where}.`));
    if (links && links.order) {
      blocks.push(button("Start a delivery order", links.order));
    }
  } else {
    blocks.push(p(`Unfortunately, ${where} is outside of our delivery ` +
      "range. On-farm pickup and the drop site are open to everyone, " +
      "with no minimum and no fee."));
  }
  blocks.push(customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// The sign-in link.
export const magicLink = (email, url, { minutes = 15, links } = {}) => {
  const title = "Your secure sign-in link to North Foster Farm";
  const blocks = [
    p("Click the button below to sign in. This link expires in " +
      `${minutes} minutes.`),
    button("Sign in", url),
    p("If you didn't request this email, you can safely ignore it."),
    row([["Need help? Contact us", contactUrl(links)]]),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// Farm news: the one click that puts an address from the old list on
// the new one, when it is asked to opt in again. A sign-up on the site
// needs no click (W1). The wording is James's, on the pattern of the
// sign-in email, ending on his line for the old list (W19).
export const newsConfirm = (email, url, { days = 7, links } = {}) => {
  const title = "Confirm your email for farm news from North Foster Farm";
  const blocks = [
    p("Click the button below to receive farm news from North Foster " +
      "Farm."),
    button("Sign up", url),
    p(`This link expires in ${days} days. You're receiving this ` +
      "message because you previously joined our mailing list."),
    row([["Need help? Contact us", contactUrl(links)]]),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// Farm news: the welcome to anyone who joins on the site (T6, James,
// 2026-09-28), since it is the only word they get that it worked.
// `unsubscribeUrl` takes them off in one click, no sign-in (T6c).
export const newsWelcome = (who, unsubscribeUrl, { links } = {}) => {
  const title = "You're on the North Foster Farm list";
  const name = firstName(who);
  const blocks = [
    p(name ? `Hi ${name},` : "Hi,"),
    p("Thanks for signing up. You're on our farm news list."),
    p("Every now and then, we'll email you what's happening on the " +
      "farm: what's in stock, where to find us, and news from the " +
      "pasture. We hope it goes without saying, but we will never " +
      "sell or give out your address."),
    {
      text: "Don't want these after all? Unsubscribe here: " +
        `${unsubscribeUrl}. One click and you're off.`,
      html: "<p>Don't want these after all? " +
        `<a href="${escape(unsubscribeUrl)}" style="color:${GREEN}">` +
        "Unsubscribe here</a>. One click and you're off.</p>",
    },
    p("— James and Jim"),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// --- To the farm ---------------------------------------------------
//
// These are the farm's notice of an order. They go to ADMIN_EMAILS
// and carry the Admin link to the dashboard.

const CONTACT_WORD = { text: "prefers a text", call: "prefers a call" };

const adminUrl = (links, path) =>
  (links && links.admin ? `${links.admin}/${path}` : null);

// The dashboard doesn't show the site's orders or customers yet, so
// "View order" and "View customer" would open a list without them
// (T5b, 2026-09-28). Set true when it does, and the buttons return.
const DASHBOARD_VIEWS = false;

const customerUrl = (links, email) => (DASHBOARD_VIEWS
  ? adminUrl(links, `customers/${encodeURIComponent(email || "")}`)
  : null);

const orderAdminUrl = (links, id) => (DASHBOARD_VIEWS
  ? adminUrl(links, `orders/${encodeURIComponent(id)}`)
  : null);

const mapsUrl = (a) =>
  `https://maps.apple.com/?address=${encodeURIComponent(streetAddress(a))}`;

// To the farm, when a customer sets or changes an address outside the
// delivery area.
export const addressReview = (customer, { links } = {}) => {
  const a = customer.address || {};
  const who = customer.name || customer.email;
  const url = customerUrl(links, customer.email);
  const title = `Address to review: ${who}`;
  const blocks = [
    url
      ? {
        text: `${who} (${url}) saved an address outside of the ` +
          "published delivery area.",
        html: `<p><a href="${escape(url)}" style="color:${GREEN}">${
          escape(who)}</a> saved an address outside of the published ` +
          "delivery area.</p>",
      }
      : p(`${who} (${customer.email}) saved an address outside of the ` +
        "published delivery area."),
    p(`Location: **${streetAddress(a)}**`),
    button("View location in Maps", mapsUrl(a)),
    p("Approve it:"),
    command(`bin/nff address approve ${customer.email}`),
    p("Or deny it:"),
    command(`bin/nff address deny ${customer.email}`),
    adminFooter(links),
  ];

  return {
    subject: title, ...render(title, blocks, links, { tag: "Address review" }),
  };
};

const customerDetails = (order, links) => {
  const c = order.customer;
  const word = CONTACT_WORD[c.contact];
  const items = [c.name || c.email, mono(c.email)];

  if (c.phone) items.push(`${c.phone}${word ? `, ${word}` : ""}`);

  const blocks = [heading("Customer details"), tree(items)];
  const url = customerUrl(links, c.email);

  if (url) blocks.push(button("View customer", url));

  return blocks;
};

// Where it goes: the address, cooler and notes for a delivery, the
// when and where for a pickup.
const farmOrderType = (order) => {
  const f = order.fulfilment;

  if (f.method !== "delivery") return orderType(order);

  const d = f.delivery || {};
  const items = [
    `Address: ${streetAddress(d)}`,
    `Cooler: ${d.cooler || "not given"}`,
  ];

  if (d.gate) items.push(`Gate or door code: ${d.gate}`);

  const notes = instructions(order);

  if (notes) items.push(`Notes: ${notes}`);

  return [p(`Order type: **${methodName(f.method)}**`), list(items)];
};

// How the money came, for the farm: "$55 by Visa ending 4242", "$55
// by Venmo", "$55 by Apple Pay". Cash or a check, from the CLI, name
// themselves.
const WALLETS = {
  applepay: "Apple Pay", googlepay: "Google Pay", cashapp: "Cash App Pay",
};

const onePayment = (p) => {
  const total = dollars(p.amount);
  const brand = (p.brand || "card").toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  if (p.via === "venmo") return `${total} by Venmo`;
  if (WALLETS[p.method]) return `${total} by ${WALLETS[p.method]}`;
  if (p.last4) return `${total} by ${brand} ending ${p.last4}`;
  if (p.via && p.via !== "square") return `${total} by ${p.via}`;

  return `${total} by card`;
};

// "$42 by Visa ending 1111"; an order changed after paying names each
// payment: "$42 by Visa ending 1111, then $12 by Venmo".
export const paymentPhrase = (order) => {
  const payments = paymentsOf(order);

  return payments.length
    ? payments.map(onePayment).join(", then ")
    : onePayment({ amount: order.totals.total });
};

// The moment an order is placed, which is the moment it is paid.
export const farmOrderPlaced = (order, { squareUrl, links } = {}) => {
  const title = `New order ${order.id} — ${dollars(order.totals.total)}, ` +
    `${methodName(order.fulfilment.method).toLowerCase()}`;
  const url = orderAdminUrl(links, order.id);
  const blocks = [
    ...customerDetails(order, links),
    heading("Order details"),
  ];

  if (url) blocks.push(button("View order", url));
  blocks.push(
    orderNumber(order, { copyable: true }),
    lines(order, { prices: true }),
    totalsBlock(order),
    ...farmOrderType(order)
  );
  blocks.push(p(`Paid: **${paymentPhrase(order)}**`));
  if (squareUrl) blocks.push(button("View order in Square", squareUrl));
  blocks.push(adminFooter(links));

  return {
    subject: title, ...render(title, blocks, links, { tag: "New order" }),
  };
};

// The customer changed what is in a paid order, or how they get it,
// from their account page. `before` is the edit's record of the order
// as it was; `difference` what they paid more (or got back, below 0).
export const farmOrderChanged = (order, {
  before, difference = 0, links,
} = {}) => {
  const c = order.customer;
  const title = `Order changed: ${order.id}, now ${
    dollars(order.totals.total)}`;
  const url = orderAdminUrl(links, order.id);
  const blocks = [
    p(`${c.name || c.email} changed order ${order.id}.`),
    ...(before ? removedGroup(order, before) : []),
    heading("Now"),
    lines(order, { prices: true }),
    totalsBlock(order),
    ...farmOrderType(order),
  ];

  if (before) {
    blocks.push(
      heading("Before"),
      lines({ lines: before.lines }, { prices: true }),
      p(`Total ${dollars(before.totals.total)}, ${
        methodName(before.method).toLowerCase()}`)
    );
  }
  if (difference > 0) {
    blocks.push(p(`They paid **${dollars(difference)} more**.`));
  } else if (difference < 0) {
    blocks.push(p(`**${dollars(-difference)} refunded** to them.`));
  }
  blocks.push(p(`Paid: **${paymentPhrase(order)}**`));
  if (url) blocks.push(button("View order", url));
  blocks.push(adminFooter(links));

  return {
    subject: title,
    ...render(title, blocks, links, { tag: "Order changed" }),
  };
};

// The customer moved an on-farm order to another time the schedule
// offers, from their account page. Booked as it stands (W11d); the
// farm only hears of it.
export const farmPickupChanged = (order, { links } = {}) => {
  const c = order.customer;
  const title = `Pickup moved: ${order.id}`;
  const url = orderAdminUrl(links, order.id);
  const blocks = [
    p(`${c.name || c.email} moved order ${order.id} to a new pickup ` +
      "time."),
    p(`Now: **${windowPhrase(order)}**`),
  ];

  if (url) blocks.push(button("View order", url));
  blocks.push(adminFooter(links));

  return {
    subject: title,
    ...render(title, blocks, links, { tag: "Pickup moved" }),
  };
};

// A customer's own words, set off with the brand green.
const quote = (text) => ({
  text: `\n${text}\n`,
  html: `<blockquote style="margin:16px 0;padding:8px 16px;` +
    `border-left:3px solid ${GREEN};white-space:pre-wrap">${
      escape(text)}</blockquote>`,
});

// A message from the contact page. Reply-to is the writer, so the
// farm answers by replying. `order` says whether the order number
// given belongs to the writer's email: true, false, or null for none.
export const farmContactMessage = (message, { order = null, links } = {}) => {
  const title = `Message from ${message.name}${
    message.orderId ? ` about ${message.orderId}` : ""}`;
  const about = message.orderId
    ? [{
      text: `Order ${message.orderId}${order
        ? ", placed with this email"
        : ": no order by that number with this email"}`,
      html: `Order ${mono(message.orderId).html}${order
        ? ", placed with this email"
        : ": no order by that number with this email"}`,
    }]
    : [];
  const blocks = [
    p(`${message.name} wrote from the contact page. Reply to this ` +
      "email to answer them."),
    tree([mono(message.email), ...about]),
    quote(message.message),
  ];
  const url = order ? orderAdminUrl(links, message.orderId) : null;

  if (url) blocks.push(button("View order", url));
  blocks.push(adminFooter(links));

  return {
    subject: title,
    ...render(title, blocks, links, { tag: "Message from the website" }),
  };
};

// The account page's notices to the farm, on the same card as the
// rest. `links` gives them their Admin link (and, once the dashboard
// shows them, the View order and View customer buttons).

// "delivery on Thursday, October 8".
const methodOn = (f) =>
  `${methodName(f.method).toLowerCase()} on ${label(f.date)}`;

const farmCard = (title, tag, blocks, links, { orderId, customer } = {}) => {
  const order = orderId ? orderAdminUrl(links, orderId) : null;
  const who = customer ? customerUrl(links, customer) : null;

  if (order) blocks.push(button("View order", order));
  if (who) blocks.push(button("View customer", who, { outline: true }));
  blocks.push(adminFooter(links));

  return { subject: title, ...render(title, blocks, links, { tag }) };
};

// A customer cancelled a paid order; the farm refunds it by hand.
export const farmRefundNeeded = (order, customer, { links } = {}) => {
  const who = customer.name || customer.email;

  return farmCard(
    `Refund needed: ${order.id} cancelled by ${customer.email}`,
    "Refund needed",
    [
      p(`${who} cancelled paid order ${order.id}, ${
        methodOn(order.fulfilment)}. Refund it and close it:`),
      command(`bin/nff orders cancel ${order.id}`),
    ],
    links, { orderId: order.id }
  );
};

// A customer's cancel, refunded on the spot (T1d): nothing to run,
// only an order not to pack.
export const farmOrderCancelled = (order, customer, { links } = {}) => {
  const who = customer.name || customer.email;
  const back = (order.refunds || [])
    .filter((r) => r.source === "customer")
    .reduce((s, r) => s + (r.amount || 0), 0);

  return farmCard(
    `Cancelled: ${order.id} by ${customer.email}`,
    "Order cancelled",
    [
      p(`${who} cancelled paid order ${order.id}, ${
        methodOn(order.fulfilment)}. ${back
        ? `We refunded ${dollars(back)} automatically; there's nothing ` +
          "to run."
        : "Nothing was left to refund."} Don't pack it.`),
    ],
    links, { orderId: order.id }
  );
};

// A customer's change saved here but not in Square.
export const farmSquareOutOfSync = (order, customer, { links } = {}) =>
  farmCard(`Square out of sync: ${order.id}`, "Square out of sync", [
    p(`${customer.name || customer.email} changed order ${order.id}, but ` +
      "Square could not be updated. Check the fulfilment in Square: " +
      `${methodOn(order.fulfilment)}.`),
  ], links, { orderId: order.id });

// A return or problem report; `entry` is the request as recorded, its
// items by SKU, named here by the order's lines.
export const farmReturnRequest = (order, customer, entry, {
  links,
} = {}) => {
  const who = customer.name || customer.email;
  const named = (sku) => ((order.lines || []).find((l) => l.sku === sku)
    || { label: sku }).label;
  const items = entry.skus.map(named);

  return farmCard(
    `Return request: ${order.id} from ${customer.email}`,
    "Return request",
    [
      p(`${who} asked about a return on order ${order.id}.`),
      quote(entry.reason),
      p(`Items: ${items.join(", ") || "not specified"}`),
      p("Settle it with:"),
      command(`bin/nff returns resolve ${order.id} ${entry.id}`),
    ],
    links, { orderId: order.id }
  );
};

// A message from the account page, with the customer's details.
// Reply-to is the customer, so the farm answers by replying.
export const farmSupport = (customer, { subject, message, orderId }, {
  links,
} = {}) => {
  const who = customer.name || customer.email;
  const about = [mono(customer.email)];

  if (customer.phone) about.push(customer.phone);
  if (orderId) {
    about.push({
      text: `Order ${orderId}`, html: `Order ${mono(orderId).html}`,
    });
  }

  return farmCard(
    `Support: ${subject || "(no subject)"} from ${customer.email}`,
    "Support",
    [
      p(`${who} wrote from their account page. Reply to this email to ` +
        "answer them."),
      tree(about),
      quote(message),
    ],
    links, { orderId, customer: customer.email }
  );
};

// --- Monitoring ----------------------------------------------------

const when = (iso) => (iso ? `${iso.replace("T", " ").slice(0, 16)} UTC`
  : "never");

// A failure on the critical path, one per kind per hour, with the
// runbook's entry for it in the body.
export const farmAlert = (kind, detail = {}, { at, links } = {}) => {
  const title = `Site alert: ${kind}`;
  const guide = GUIDE[kind];
  const rows = Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
  const blocks = [
    p(`**${kind}** at ${when(at ? at.toISOString() : null)}. Further ` +
      "alerts of this kind are held for an hour."),
  ];

  if (rows.length) blocks.push(table(["Field", "Value"], rows));
  if (guide) {
    blocks.push(
      heading("What this means"),
      p(guide.means),
      heading("What to do"),
      p(guide.action)
    );
  } else {
    blocks.push(p("This alert has no entry in the runbook yet."));
  }
  blocks.push(
    button("Open the runbook", RUNBOOK_ALERTS, { outline: true }),
    adminFooter(links)
  );

  return {
    subject: title, ...render(title, blocks, links, { tag: "Site alert" }),
  };
};

// Every morning at 8:00: the site's vital signs for the last day, then
// whatever waits on the farm. Sent even when nothing does, so its
// absence is a signal.
// Each vital sign: the figure, and whether a healthy day looks like
// this. GOOD is within limits, BAD outside them, PLAIN a number with
// no limits, just worth knowing.
const GOOD = "🐣";
const BAD = "🙈";
const PLAIN = "🫥";
const within = (ok) => (ok ? GOOD : BAD);
// Under the table, set off from it by a blank line in text.
const legend = p(`${GOOD} within healthy limits, ${BAD} outside limits ` +
  `and worth looking into, ${PLAIN} a number with no limits but worth ` +
  "knowing");
const key = { ...legend, text: `\n${legend.text}` };
const VITALS = [
  ["placed", "Orders placed", () => PLAIN],
  ["paidByCard", "Paid by card or a wallet", () => PLAIN],
  ["paidByVenmo", "Paid by Venmo", () => PLAIN],
  ["declined", "Payments declined", (s) => within(s.declined <= 3)],
  ["cancelled", "Cancelled by a customer or the farm", () => PLAIN],
  ["refunded", "Refunded", () => PLAIN],
  ["open", "Open orders, paid and not yet fulfilled", () => PLAIN],
  ["mailFailures", "Emails that could not be sent",
    (s) => within(s.mailFailures === 0)],
  ["runs", "Jobs runs (one every 15 minutes is 96)",
    (s) => within(s.runs >= 90)],
  ["jobErrors", "Jobs errors", (s) => within(s.jobErrors === 0)],
  ["invariants", "Invariant violations", (s) => within(s.invariants === 0)],
];

const age = (iso, now) => {
  const hours = Math.round((now.getTime() - Date.parse(iso)) / 3_600_000);

  return hours < 1 ? "under an hour" : hours < 48 ? `${hours} h`
    : `${Math.round(hours / 24)} days`;
};

export const farmMorningReport = (stats, pickups, {
  date, links, now = new Date(), schedule = null,
} = {}) => {
  const title = `Morning report: ${label(date)}`;
  const blocks = [
    heading("Vital signs: the last 24 hours"),
    table(["", "Last 24 h", ""],
      VITALS.map(([key, name, judge]) => [name, String(stats[key]),
        judge(stats)]),
      { align: ["left", "right", "center"] }),
    key,
  ];

  // The schedule running short is the farm's to fix, before the
  // next deploy fails on it (W11d). `schedule`: { last, until }.
  if (schedule && (!schedule.last || schedule.last < schedule.until)) {
    blocks.push(
      heading("Pickup schedule"),
      p(`**${schedule.last
        ? `The pickup schedule's last window is on ${
          label(schedule.last)}; it must reach the week of ${
          label(schedule.until)}.`
        : "The pickup schedule offers no windows."}**`),
      p("Add windows and deploy, or the next deploy fails:"),
      command("bin/nff schedule set <file>")
    );
  }
  if (pickups.length) {
    blocks.push(
      heading("Pickups waiting on the customer"),
      p("We couldn't keep these pickup times and the customer hasn't " +
        "chosen another yet, oldest order first."),
      table(["Order", "Customer", "Was", "Waiting"],
        pickups.slice().sort((a, b) => (a.submittedAt < b.submittedAt
          ? -1 : 1)).map((o) => [
          mono(o.id),
          o.customer.name || o.customer.email,
          windowPhrase(o),
          age(o.question.openedAt || o.submittedAt, now),
        ]))
    );
  } else {
    blocks.push(p("No pickups waiting on the customer."));
  }
  blocks.push(adminFooter(links));

  return {
    subject: title, ...render(title, blocks, links, { tag: "Morning report" }),
  };
};

// Every evening at 6:00: every order due tomorrow, by method, with
// what the driver or the packer needs. The manifest the farm would
// otherwise rebuild if anything broke overnight. Sent even when empty.
export const farmTomorrow = (orders, { date, links } = {}) => {
  const day = label(date);
  const title = `Tomorrow, ${day}: ${orders.length} order${
    orders.length === 1 ? "" : "s"}`;
  const by = (method) => orders.filter((o) => o.fulfilment.method === method);
  const deliveries = by("delivery");
  const drops = by("scituate");
  const farm = by("onfarm");
  const blocks = [];
  const who = (o) => `${o.customer.name || o.customer.email}${
    o.customer.phone ? `, ${o.customer.phone}` : ""}`;
  const pack = (o) => ({
    text: "Pack:", children: o.lines.map((l) => `${l.qty} × ${l.label}`),
  });
  // A delivery is abandoned at the Wednesday cutoff if unpaid, so an
  // unpaid one on this list means that step did not happen.
  const state = (o) => (o.status === "paid" ? "paid"
    : o.fulfilment.method === "delivery"
      ? "**UNPAID, past the cutoff: it should have been cancelled; " +
        "check it before loading**"
      : "UNPAID");

  if (!orders.length) {
    blocks.push(p(`Nothing due ${day}.`));
  }
  if (deliveries.length) {
    blocks.push(heading(`Deliveries (${deliveries.length})`));
    for (const o of deliveries) {
      const d = o.fulfilment.delivery || {};
      const items = [
        `Address: ${streetAddress(d)}`,
        `Cooler: ${d.cooler || "not given"}`,
      ];

      if (d.gate) items.push(`Gate or door code: ${d.gate}`);
      if (instructions(o)) items.push(`Notes: ${instructions(o)}`);
      items.push(pack(o));
      blocks.push(p(`**${o.id}**, ${who(o)}, ${state(o)}`), tree(items));
    }
  }
  if (drops.length) {
    blocks.push(heading(`Drop site, ${terms.scituate.window} (${
      drops.length})`));
    for (const o of drops) {
      blocks.push(p(`**${o.id}**, ${who(o)}, ${state(o)}`), tree([pack(o)]));
    }
  }
  if (farm.length) {
    blocks.push(heading(`On-farm pickups (${farm.length})`));
    for (const o of farm) {
      blocks.push(p(`**${o.id}**, ${who(o)}, ${pickupWindow(o)}, ${
        state(o)}`),
      tree([pack(o)]));
    }
  }
  blocks.push(adminFooter(links));

  return {
    subject: title, ...render(title, blocks, links, { tag: "Tomorrow" }),
  };
};

// A short line for the CLI and logs.
export const summaryLine = (order) =>
  `${order.id} ${order.status} ${dollars(order.totals.total)} ` +
  `${methodName(order.fulfilment.method)} ${order.fulfilment.date} ` +
  `${order.customer.email}`;
