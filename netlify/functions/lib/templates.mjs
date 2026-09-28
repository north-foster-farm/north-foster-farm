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

import accounts from "../../../data/accounts.json" with { type: "json" };
import terms from "../../../data/delivery.json" with { type: "json" };
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, dayName, label, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { GUIDE, RUNBOOK_ALERTS } from "./alerts-guide.mjs";
import { company } from "./company.mjs";
import {
  between, methodName, packetCounts, pickupWindow, streetAddress,
} from "./describe.mjs";
import { now as clock } from "./clock.mjs";
import { currentOptIn, keptFee, paymentsOf } from "./records.mjs";

// The delivery day by name, and how long a missed delivery is
// held for the customer to choose, from data/delivery.json.
const DELIVERY_DAY = dayName(terms.delivery.weekday);
const HOLD_DAYS = terms.delivery.holdDays;

// A small count in words, as the emails write it: 7 is "seven".
const inWords = (n) => [
  "zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten",
][n] || String(n);

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

// The site's look, inlined: the system font stack (no web font, so no
// font file leaves the site), the wordmark in the header's green,
// cards with the account page's border, radius and shadow. The <style>
// block does what inline styles cannot: stop iOS Mail restyling the
// address and phone in the footer as blue links.
const GREEN = "#186243"; // $primary: the brand green, shaded 20%.
const INK = "#161a1e"; // $gray-900, the body text.
const MUTED = "#5e5e5f"; // $gray-600.
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto," +
  "'Helvetica Neue',Arial,sans-serif";

const styles = () => `<style>
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
    `<title>${escape(title)}</title>${styles()}</head>` +
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

// The support address, a mailto link (#240): "[contact us]" in a
// paragraph is a link to it in the HTML and "contact us at info@..."
// in the plain text.
const SUPPORT = company.emailInfo;
const pSupport = (text) => ({
  text: text.replace("[contact us]", `contact us at ${SUPPORT}`),
  html: `<p>${inline(text).replace("[contact us]",
    `<a href="mailto:${escape(SUPPORT)}" style="color:${GREEN}">contact ` +
    "us</a>")}</p>`,
});

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
        `Where: ${company.address.street}, ${company.address.city}, ` +
          `${company.address.state} ${company.address.zip}`,
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
// does not price anything either. On the customer's first order it
// says, once, that the order made them an account (#114); that needs
// the account pages, so only with `orderUrl`.
export const orderConfirmed = (order, {
  orderUrl, links, firstOrder = false,
} = {}) => {
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
    // Wording approved by James, 2026-10-22 (#114).
    if (firstOrder) {
      blocks.push(p("Your email address is your account with us. Sign " +
        "in any time with a link we email you; there's no password."));
    }
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

// A year without interaction (#189, D-189): the one notice, sent once.
// The account stays; they are off farm news if they were on it.
// `wasSubscribed` says whether this run took them off. DRAFT: every
// line is for James's approval (Q8).
export const quietNotice = (customer, {
  accountUrl = null, links, wasSubscribed = false,
} = {}) => {
  const title = "Your account is still here";
  const name = firstName(customer);
  const blocks = [
    p(name ? `Hi ${name},` : "Hi,"),
    p("It's been a year since you last signed in or ordered from us, " +
      "so we wanted to let you know where things stand."),
  ];

  if (wasSubscribed) {
    blocks.push(p("We've stopped sending you our farm news emails. You " +
      "can turn them back on in your account settings at any time."));
  }
  blocks.push(
    p("You don't need to do anything. Your account stays open, and " +
      "we'll be glad to see you whenever you're back."),
    p("If you'd rather we didn't keep your details, you can delete them " +
      "in one click in your account settings."),
  );
  if (accountUrl) blocks.push(button("Go to your account", accountUrl));
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
// drafts of 2026-09-28, to approve. The hold runs to the order's
// `question.until`; an email sent after the day of the miss (a resend,
// a late mark) names that day instead of "today" (draft).

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

export const missedDelivery = (order, {
  pickUrl, links, now = new Date(),
} = {}) => {
  const title = "We couldn't deliver your order";
  const fee = keptFee(order);
  const { date } = order.fulfilment;
  const late = today(now, terms.timeZone) > date;
  const next = dayAfter(date, 7);
  const hold = label((order.question && order.question.until)
    || addDays(date, HOLD_DAYS));
  const items = dollars(order.totals.total - fee);
  const blocks = [
    p(`Hi ${firstName(order.customer)},`),
    p(`We came by ${late ? `on ${label(date)}` : "today"} with your order ` +
      `but couldn't leave it: ${missedReason(order)}. Your order is back ` +
      "at the farm."),
  ];

  if (fee) {
    blocks.push(
      p("Please choose what you'd like us to do:"),
      list([
        `Deliver it next ${DELIVERY_DAY}, ${next}, for another ` +
          "delivery fee " +
          `of ${dollars(fee)}`,
        "Have it ready for pickup at the farm or the drop site, at no " +
          "charge",
        `Cancel it, and we'll refund ${items} for your items`,
      ]),
      p(`${late ? "That day's" : "Today's"} delivery fee of ${
        dollars(fee)} isn't refunded, ` +
        "whichever you choose."),
      p(`We'll hold your order until ${hold}. If you haven't chosen by ` +
        `then, we'll cancel it and refund ${items} for your items.`)
    );
  } else {
    blocks.push(
      p("Please choose what you'd like us to do:"),
      list([
        `Deliver it next ${DELIVERY_DAY}, ${next}, at no extra charge`,
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
// have moved it to the next delivery day; they may pick otherwise.
// `order` is the moved record, and `attempted.date` the day we missed;
// a holiday a week on puts the new day further out, and the email
// names it without "next". Policy-pages' draft of 2026-09-28, to
// approve; `orders attempted` sends it.
export const movedDelivery = (order, { pickUrl, links } = {}) => {
  const a = order.attempted || {};
  const date = order.fulfilment.date;
  const next = !a.date || addDays(a.date, 7) === date;
  const when = next ? `next ${DELIVERY_DAY}` : DELIVERY_DAY;
  const title = `Your delivery is moved to ${next ? when : label(date)}`;
  const why = a.cause === "weather"
    ? "The weather kept us from delivering your order today"
    : "We weren't able to deliver your order today";
  const blocks = [
    p(`Hi ${firstName(order.customer)},`),
    p(`${why}, so we've moved your delivery to ${when}, ${
      dayAfter(date, 0)}. You don't need to do anything.`),
    p(`If ${next ? when : "that day"} doesn't suit you, you can choose ` +
      "another day, " +
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
    blocks.push(p(`We held your order for ${inWords(HOLD_DAYS)} days and ` +
      "didn't hear from you, so we've cancelled it."));
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
export const magicLink = (email, url, {
  minutes = accounts.signInLinkMinutes, links,
} = {}) => {
  const title = `Your secure sign-in link to ${company.name}`;
  const blocks = [
    p("Click the button below to sign in. This link expires in " +
      `${minutes} minutes.`),
    button("Sign in", url),
    p("If you didn't request this email, you can safely ignore it."),
    row([["Need help? Contact us", contactUrl(links)]]),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// A customer's own email change (#240), in two parts: the link to the
// new email address, which alone moves the account, and the word to the
// old one once it has moved. James's approved wording.
export const emailChangeLink = (email, url, {
  minutes = accounts.signInLinkMinutes, links,
} = {}) => {
  const title = `Confirm your new email address for ${company.name}`;
  const blocks = [
    p(`Click the link below to change your ${company.name} email ` +
      `address. This link expires in ${minutes} minutes.`),
    button("Confirm new email address", url),
    p("If you didn't request this change, you can safely ignore it."),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

export const emailChanged = (from, to, { links } = {}) => {
  const title = `The email address on your ${company.name} account ` +
    "was changed";
  const blocks = [
    p(`Your email address has been changed from ${from} to ${to}. ` +
      "Order emails and farm news, if you get it, will be sent to the " +
      "new email address from now on."),
    pSupport("If you didn't make this change, [contact us] for " +
      "additional support right away."),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// --- List mail (#273) ----------------------------------------------
//
// Mail to the list, as against mail about an order: the welcome, the
// old list's invitation and, later, newsletters. The same look as the
// rest (the wordmark, the card, the green), with what list mail
// needs on top: a hero image, images with captions, preview text, a
// footer that says why it came and how to stop it, and the farm's
// postal address (CAN-SPAM). It follows the reader's dark mode where
// the mail app allows it; the order emails stay light.

// The dark palette, from the site's colors lifted for a dark ground.
const DARK = {
  ground: "#111513",
  card: "#1b201d",
  ink: "#e7eae8",
  muted: "#a9b0ac",
  green: "#8fd1ae",
  button: "#23794f",
  edge: "rgba(255,255,255,.16)",
};

// Apple Mail, iOS Mail and Outlook for Mac honor the media query;
// Outlook.com marks its dark mode with [data-ogsc]. Gmail ignores
// both and shows the light version. The wordmark is dark green, so in
// dark mode it is drawn light.
const darkStyles = `<style>
@media (prefers-color-scheme:dark){
.nff-ground{background:${DARK.ground}!important}
.nff-card{background:${DARK.card}!important;
border-color:${DARK.edge}!important}
.nff-ink,.nff-ink p,.nff-ink h2{color:${DARK.ink}!important}
.nff-muted,.nff-ink .nff-muted{color:${DARK.muted}!important}
.nff-link{color:${DARK.green}!important}
.nff-btn{background:${DARK.button}!important;
border-color:${DARK.button}!important;color:#fff!important}
.nff-logo{filter:brightness(0) invert(.92)}
}
[data-ogsc] .nff-ground{background:${DARK.ground}!important}
[data-ogsc] .nff-card{background:${DARK.card}!important}
[data-ogsc] .nff-ink{color:${DARK.ink}!important}
[data-ogsc] .nff-muted{color:${DARK.muted}!important}
[data-ogsc] .nff-link{color:${DARK.green}!important}
@media (max-width:480px){
.nff-pad{padding:20px 18px 8px!important}
.nff-btn{display:block!important;text-align:center!important}
}
</style>`;

const link = (text, url) =>
  `<a href="${escape(url)}" class="nff-link" style="color:${GREEN}">${
    escape(text)}</a>`;

// The blocks a list email is built from, exported for newsletters.
// Each is { text, html }, like the order emails' blocks.
export const listBlocks = {
  p: (text) => ({
    text, html: `<p style="margin:0 0 16px">${inline(text)}</p>`,
  }),
  heading: (text) => ({
    text: `\n${text.toUpperCase()}`,
    html: `<h2 style="margin:28px 0 10px;font-size:20px;line-height:1.3">${
      escape(text)}</h2>`,
  }),
  button: (text, url) => ({
    text: `${text}: ${url}`,
    html: `<p style="margin:24px 0"><a href="${escape(url)}" class="nff-btn" ` +
      `style="${BTN}padding:12px 22px;border:1px solid ${GREEN};` +
      `color:#fff;background:${GREEN}">${escape(text)}</a></p>`,
  }),
  // An image across the card, with an optional caption under it.
  image: (src, alt, caption = "") => ({
    text: `[Photo: ${alt}]${caption ? `\n${caption}` : ""}`,
    html: `<p style="margin:24px 0 ${caption ? "6px" : "24px"}"><img ` +
      `src="${escape(src)}" alt="${escape(alt)}" width="512" ` +
      `style="display:block;width:100%;max-width:512px;height:auto;` +
      `border:0;border-radius:4px"></p>${caption
        ? `<p class="nff-muted" style="margin:0 0 24px;font-size:14px;` +
        `line-height:1.5;color:${MUTED}">${inline(caption)}</p>`
        : ""}`,
  }),
  // A line with one link in it: `before`, the link, then `after`.
  linked: (before, text, url, after = "") => ({
    text: `${before}${text}: ${url}${after}`,
    html: `<p style="margin:0 0 16px">${inline(before)}${link(text, url)}${
      inline(after)}</p>`,
  }),
};

// The page around the blocks. `reason` ends "You're getting this
// because ..."; `unsubscribeUrl` is the one-click link, left out only
// for the invitation, which goes to someone not on the list.
// -> { subject, text, html }
export const listMail = (subject, {
  preview = "", hero = null, blocks = [], reason = "",
  unsubscribeUrl = null, links = {},
} = {}) => {
  const site = links.site;
  const address = `${company.address.street}, ${company.address.city}, ` +
    `${company.address.state} ${company.address.zip}`;
  const why = reason ? `You're getting this because ${reason}.` : "";
  const text = [
    ...(hero ? [`[Photo: ${hero.alt}]`, ""] : []),
    ...blocks.flatMap((b) => [b.text, ""]),
    "--",
    why,
    unsubscribeUrl ? `Unsubscribe in one click: ${unsubscribeUrl}` : "",
    "",
    company.name,
    address,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
  const logo = site
    ? `<p style="margin:0 0 20px;text-align:center"><img class="nff-logo" ` +
      `src="${site}/images/email/logo.png" width="280" ` +
      `alt="${escape(company.name)}" style="display:block;margin:0 auto;` +
      `width:280px;max-width:100%;height:auto;border:0"></p>`
    : header(site);
  // The preview text, hidden; the spaces after it keep the mail app
  // from filling the rest of the preview with the body.
  const pre = preview
    ? `<div style="display:none;max-height:0;overflow:hidden;` +
      `mso-hide:all">${escape(preview)}${"&#8199;&#847; ".repeat(40)}</div>`
    : "";
  const heroHtml = hero
    ? `<img src="${escape(hero.src)}" alt="${escape(hero.alt)}" ` +
      `width="560" style="display:block;width:100%;height:auto;border:0;` +
      `border-radius:5px 5px 0 0">`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="format-detection" ` +
    `content="telephone=no, date=no, address=no, email=no">` +
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="supported-color-schemes" content="light dark">` +
    `<title>${escape(subject)}</title>${styles()}${darkStyles}</head>` +
    `<body id="body" class="nff-ground" style="margin:0;padding:0;` +
    `background:#f6f7f6;font-family:${FONT};font-size:17px;color:${INK};` +
    `line-height:1.6">${pre}` +
    `<div class="nff-ground" style="background:#f6f7f6;padding:24px 12px">` +
    `<div style="max-width:560px;margin:0 auto">${logo}` +
    `<div class="nff-card" style="background:#fff;` +
    `border:1px solid rgba(0,0,0,.175);border-radius:6px;` +
    `box-shadow:0 2px 3px rgba(7,6,6,.2)">${heroHtml}` +
    `<div class="nff-pad nff-ink" style="padding:28px 24px 12px;` +
    `color:${INK}">${blocks.map((b) => b.html).join("")}</div></div>` +
    `<div class="nff-muted" style="margin:20px 0 0;padding:0 12px;` +
    `font-size:13px;line-height:1.6;text-align:center;color:${MUTED}">` +
    `${why ? `<p style="margin:0 0 8px">${escape(why)}</p>` : ""}` +
    `${unsubscribeUrl
      ? `<p style="margin:0 0 8px">${link("Unsubscribe", unsubscribeUrl)}` +
        " in one click.</p>"
      : ""}` +
    `<p style="margin:0">${escape(company.name)}<br>${escape(address)}` +
    `</p></div></div></div></body></html>`;

  return { subject, text, html };
};

// "July", from an ISO time, in the farm's zone.
const month = (iso) => new Date(iso).toLocaleDateString("en-US", {
  month: "long", timeZone: "America/New_York",
});

// "October 20, 2026"
const longDate = (iso) => new Date(iso).toLocaleDateString("en-US", {
  month: "long", day: "numeric", year: "numeric",
  timeZone: "America/New_York",
});

// How someone came onto the list, in plain words, from their opt-in
// event (records.mjs): "you signed up on our website". Draft (#267).
export const optInPhrase = (event) => {
  const detail = (event && event.detail) || "";

  switch (event && event.type) {
  case "website-form":
    return "you signed up on our website";
  case "checkout":
    return "you ticked the farm news box when you placed your order";
  case "account-settings":
    return "you turned on farm news in your account";
  case "reinvite-confirmation":
    return "you confirmed you'd like to keep hearing from us";
  case "market-sheet":
    return `you signed up on our sign-up sheet at ${
      detail || "one of our markets"} in ${month(event.at)}`;
  case "in-person":
    return `you asked us to add you when we met in person${
      detail ? ` at ${detail}` : ""}`;
  case "resend":
    return "you asked us to add you to our list";
  default:
    return "you joined our farm news list";
  }
};

// The contacts who were on the list before it moved to Resend: the
// market sheets and the old list's re-invite (#267).
const MIGRATED = ["market-sheet", "reinvite-confirmation"];

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Farm news: the one click that puts an address from the old list on
// the new one, when it is asked to opt in again (D-INVITE). A sign-up
// on the site needs no click (W1). The wording is James's, on the
// pattern of the sign-in email, ending on his line for the old list
// (W19); the list layout is #273's.
export const newsConfirm = (email, url, {
  days = accounts.newsInviteDays, links,
} = {}) => listMail(
  `Confirm your email for farm news from ${company.name}`, {
    preview: "One click keeps you on our list.",
    blocks: [
      listBlocks.p("Click the button below to receive farm news from " +
        `${company.name}.`),
      listBlocks.button("Sign up", url),
      listBlocks.p(`This link expires in ${days} days. You're receiving ` +
        "this message because you previously joined our mailing list."),
      listBlocks.linked("Need help? ", "Contact us", contactUrl(links)),
    ],
    links,
  },
);

// Farm news: the welcome, the one email of the welcome sequence
// (#267), to everyone who comes onto the list: a sign-up here, the
// checkout or settings box, the old list's confirmation, or an
// import. It always says how they opted in, from the consent log;
// those who were on the list before it moved hear why a welcome comes
// now. `unsubscribeUrl` takes them off in one click, no sign-in (T6c).
// T6's lines are James's (2026-09-28); the re-invite's opening and the
// rest are drafts.
export const newsWelcome = (who, unsubscribeUrl, { links } = {}) => {
  const name = firstName(who);
  const event = currentOptIn(who);
  const phrase = optInPhrase(event);
  const migrated = !!event && MIGRATED.includes(event.type);
  const b = listBlocks;
  const blocks = [
    b.p(name ? `Hi ${name},` : "Hi,"),
    b.p(`${event && event.type === "reinvite-confirmation"
      ? "Thanks for staying on our farm news list."
      : "Thanks for signing up. You're on our farm news list."} ` +
      `We're writing because ${phrase}. We don't take a place in your ` +
      "inbox lightly."),
    ...(migrated
      ? [b.p("We've moved our list to a new email provider, so this " +
        "welcome reaches you even if you've been with us for years.")]
      : []),
    b.p("Every now and then, we'll email you what's happening on the " +
      "farm: what's in stock, where to find us, and news from the " +
      "pasture. We hope it goes without saying, but we will never sell " +
      "or give out your address."),
    ...(links && links.order
      ? [b.button("See what's in stock", links.order)]
      : []),
    b.linked("Don't want these after all? ", "Unsubscribe here",
      unsubscribeUrl, ". One click and you're off."),
    b.p("— James and Jim"),
  ];

  return listMail(`You're on the ${company.name} list`, {
    preview: `${capital(phrase)}. Here's what to expect.`,
    blocks,
    reason: event && event.at
      ? `${phrase}${event.type === "market-sheet" ? ""
        : ` on ${longDate(event.at)}`}`
      : phrase,
    unsubscribeUrl,
    links,
  });
};

// --- To the farm ---------------------------------------------------
//
// These are the farm's notice of an order. They go to
// FARM_NOTIFICATIONS_EMAIL
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

// Products the catalog marks archived while stock shows them on hand
// (#267): hidden everywhere, so nobody can buy what came in. `items`
// is [{ sku, name, count }], count null when the SKU is in stock by
// its catalog flag and not counted. Also a section of the morning
// report, until each is resolved.
const archivedRows = (items) => table(["Product", "SKU", "On hand"],
  items.map((i) => [i.name, mono(i.sku),
    i.count === null ? "in stock, not counted" : String(i.count)]),
  { align: ["left", "left", "right"] });
const archivedFix = () => [
  p("If it's back on sale, change its restock type in data/catalog.json " +
    "and deploy. If not, zero its count:"),
  command("bin/nff stock set <sku> 0"),
];

export const farmArchivedInStock = (items, { links } = {}) => farmCard(
  items.length === 1
    ? `Hidden but in stock: ${items[0].name}`
    : `Hidden but in stock: ${items.length} products`,
  "Stock check",
  [
    p("Each product below is archived in the catalog, so no customer " +
      "can see or buy it, but stock shows it on hand:"),
    archivedRows(items),
    ...archivedFix(),
  ],
  links
);

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

// A failure on the critical path, one per kind per hour unless `held`
// is false, with the runbook's entry for it in the body.
export const farmAlert = (kind, detail = {}, {
  at, links, held = true,
} = {}) => {
  const title = `Site alert: ${kind}`;
  const guide = GUIDE[kind];
  const rows = Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
  const blocks = [
    p(`**${kind}** at ${when(at ? at.toISOString() : null)}.${
      held ? " Further alerts of this kind are held for an hour." : ""}`),
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

// The one message to ESCALATED_NOTIFICATIONS_EMAIL, in plain words
// for someone who is not technical (a draft; the words are James's).
export const escalation = ({ at, links, maintenanceOn } = {}) => {
  const title = "Please switch on the order pause";
  const blocks = [
    p("James hasn't responded to an urgent problem with online " +
      "orders: some payments may be going through without an order " +
      "being saved."),
    p("To stop more orders from coming in until James can look, " +
      "switch on maintenance mode with the button below. Customers " +
      "will see a short notice that the site is under maintenance."),
  ];

  if (maintenanceOn) {
    blocks.push(button("Switch on maintenance mode", maintenanceOn));
  }
  // A plain line: `row` makes each pair a link, and a time is no URL.
  const sent = when(at ? at.toISOString() : null);

  blocks.push({
    text: `\nSent: ${sent}`,
    html: `<p style="margin:24px 0 0">Sent: ${escape(sent)}</p>`,
  });

  return {
    subject: title, ...render(title, blocks, links, { tag: "Urgent" }),
  };
};

// Maintenance mode flipped, to the developer on every flip.
export const maintenanceFlipped = (on, {
  by, at, links, context,
} = {}) => {
  const title = `Maintenance mode is ${on ? "ON" : "OFF"}`
    + `${context && context !== "production" ? ` (${context})` : ""}`;
  const blocks = [
    p(on
      ? "Ordering, checkout, sign-in and the account area are closed. " +
        "Customers see the maintenance message; nothing they submit goes " +
        "through. Payments and webhooks already under way still finish."
      : "Ordering, sign-in and the account area are open again."),
    table(["Field", "Value"], [
      ["Flipped by", by || "unknown"],
      ["At", when(at ? at.toISOString() : null)],
    ]),
    adminFooter(links),
  ];

  return {
    subject: title, ...render(title, blocks, links, { tag: "Maintenance" }),
  };
};

// Every customer session ended at once, to the developer. A run that
// nobody meant is the thing this email exists to reveal.
export const sessionsEnded = ({ count, by, at, context } = {}) => {
  const title = `Every session was ended${
    context && context !== "production" ? ` (${context})` : ""}`;
  const blocks = [
    p("Every customer is signed out. Each signs in again by magic " +
      "link. If you did not run this, treat it as an incident " +
      "(docs/secrets.md)."),
    table(["Field", "Value"], [
      ["Sessions ended", String(count)],
      ["Run by", by || "unknown"],
      ["At", when(at ? at.toISOString() : null)],
    ]),
  ];

  return {
    subject: title, ...render(title, blocks, undefined, { tag: "Security" }),
  };
};

// `bin/nff mail test-dev`: one message through the path the developer's
// notices take, to prove the address is live.
export const devMailTest = ({ at, context } = {}) => {
  const title = `Developer notices test${
    context && context !== "production" ? ` (${context})` : ""}`;
  const blocks = [
    p("This is a test of the address that receives deploy-failed, " +
      "alert and rotation notices. Nothing is wrong. If you can read " +
      "this, those notices will reach you."),
    table(["Field", "Value"], [
      ["Context", context || "unknown"],
      ["At", when(at ? at.toISOString() : null)],
    ]),
  ];

  return {
    subject: title, ...render(title, blocks, undefined, { tag: "Test" }),
  };
};

// The yearly secret rotation, to the developer: Dec 1, then weekly
// while the rotation log shows something not yet rotated this window.
// `final` is the loud one in the last week of December.
export const rotationReminder = ({
  due = [], start, final = false, logFound = true, links,
} = {}) => {
  const year = Number(start.slice(0, 4));
  const title = final
    ? `FINAL REMINDER: rotate the secrets by Jan 1, ${year + 1}`
    : `Secrets are due for rotation: Dec 1 to Jan 1, ${year + 1}`;
  const blocks = [
    p(final
      ? "**The window closes in days.** Everything below is still " +
        "unrotated in the log. Rotate it now, in the quiet hour " +
        "docs/secrets.md names, and log each rotation."
      : "**Every secret rotates between Dec 1 and Jan 1.** Tokens that " +
        "can expire are set to expire Jan 31. Log each rotation in " +
        "docs/rotation-log.md as you go; this reminder repeats weekly " +
        "for what the log still shows as due."),
  ];

  if (!logFound) {
    blocks.push(p("docs/rotation-log.md was not found, so the list " +
      "below is empty. Work from the table in docs/secrets.md."));
  }
  if (due.length) {
    blocks.push(
      heading("Last rotated before Dec 1"),
      table(["Secret", "Environment", "Last rotated", "Why"],
        due.map((e) => [e.name, e.environment, e.date, e.reason]))
    );
  } else {
    blocks.push(p("The log lists nothing as rotated yet. Check " +
      "docs/secrets.md for the full set."));
  }
  blocks.push(
    p("Ping URLs, ids and the build hook rotate only on a leak: skip " +
      "them. The Square token rotates under maintenance mode."),
    adminFooter(links)
  );

  return {
    subject: title,
    ...render(title, blocks, links, { tag: "Rotation" }),
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

export const age = (iso, now) => {
  const hours = Math.round((now.getTime() - Date.parse(iso)) / 3_600_000);

  return hours < 1 ? "under an hour" : hours < 48 ? `${hours} h`
    : `${Math.round(hours / 24)} days`;
};

// The most messages the morning report lists; the rest are counted,
// and `bin/nff messages` lists them all (#167, security review).
const MESSAGES_SHOWN = 30;

export const farmMorningReport = (stats, pickups, {
  date, links, now = clock(), schedule = null, archived = [], messages = [],
  square = null,
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
  // Until the flag is flipped or the stock zeroed (#267).
  if (archived.length) {
    blocks.push(
      heading("Hidden but in stock"),
      p("Each product below is archived in the catalog, so no customer " +
        "can see or buy it, but stock shows it on hand:"),
      archivedRows(archived),
      ...archivedFix()
    );
  }
  // What the day's Square sweep found (#241). James's heading and the
  // copy lane's approved lines; the paused line is a draft. `open`
  // counts every order found, the cancelled ones among them; `paused`,
  // the Square deletion kill switch is set.
  const done = (n, verb) => (n
    ? `, and ${n} ${n === 1 ? "was" : "were"} ${verb}` : "");
  if (square && square.open) {
    const found = `${square.open} order${square.open === 1 ? "" : "s"}`;
    const left = square.open - square.cancelled;
    const all = square.open === 1 ? "it" : "them";
    const lead = `${square.open === 1 ? "A failed payment" : "Failed payments"
    } left ${found} open in Square`;
    const still = `${left} ${left === 1 ? "is" : "are"} still open`;
    let text = `${lead}. To see ${all}:`;

    if (square.cancelled && left) {
      text = `${lead}. The sweep cancelled ${square.cancelled}; ${still}. ` +
        "To see them:";
    } else if (square.cancelled) {
      text = `${lead}, and the sweep cancelled ${all}. To see ${all}:`;
    }
    if (square.paused) {
      text = `${lead}. The Square deletion kill switch is set, so the ` +
        `sweep cancels nothing. To see ${all}:`;
    }
    blocks.push(
      heading("Square sweep: open orders from failed payments"),
      p(text),
      command("bin/nff jobs square")
    );
  }
  // The profiles failed checkouts made (#236). The heading is a draft,
  // after James's for the orders.
  if (square && square.profiles) {
    const foundProfiles = `${square.profiles} customer profile${
      square.profiles === 1 ? "" : "s"}`;
    const allProfiles = square.profiles === 1 ? "it" : "them";

    const madeLead = `Checkouts whose payment never went through made ${
      foundProfiles} in Square`;

    blocks.push(
      heading("Square sweep: customer profiles from failed payments"),
      p(square.paused
        ? `${madeLead}. The Square deletion kill switch is set, so the ` +
          `sweep deletes nothing. To see ${allProfiles}:`
        : `${madeLead}${done(square.deleted, "deleted")}. To see ${
          allProfiles}:`),
      command("bin/nff jobs customers")
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
  // Every message not yet marked answered, every morning until it is
  // (#167). `messages`: admin's listMessages, oldest first.
  if (messages.length) {
    blocks.push(
      heading("Messages waiting on an answer"),
      p("From the contact page and the account page's help form, oldest " +
        "first. Once you've answered one, mark it:"),
      command("bin/nff messages done <id>"),
      table(["Message", "From", "Order", "Waiting"],
        messages.slice(0, MESSAGES_SHOWN).map((m) => [
          mono(m.id),
          m.name || m.email,
          m.orderId ? `${m.orderId}${m.order === false
            ? " (not their order)" : ""}` : "",
          age(m.at, now),
        ]))
    );
    if (messages.length > MESSAGES_SHOWN) {
      blocks.push(p(`And ${messages.length - MESSAGES_SHOWN} more. To see `
        + "every one:"), command("bin/nff messages"));
    }
  } else {
    blocks.push(p("No messages waiting on an answer."));
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

// The packing slips (#292, lib/packing.mjs), 6:00 daily, always: the
// PDF is attached, and the email lists what is in it. Wording is a
// draft.
const PACKET_KIND = {
  new: "new", weekly: "reprint", changed: "**revised**",
  cancelled: "**CANCELLED**",
};

const packetLine = (e) => {
  const f = e.order.fulfilment;
  const who = e.order.customer && e.order.customer.name;

  return `**${e.order.id}**${who ? `, ${who}` : ""}, ${
    methodName(f.method)}, ${label(f.date)}: ${PACKET_KIND[e.kind]}`;
};

export const farmPackingSlips = (entries, {
  day, sunday = false, quiet = false, slips = 0, revised = 0,
  cancelled = 0, filename = "", links,
} = {}) => {
  const when = label(day);

  if (quiet) {
    const title = `Packing slips, ${when}: nothing to print`;

    return {
      subject: title,
      ...render(title, [
        p("No order has come in, changed or been cancelled since the " +
          "last packet."),
        adminFooter(links),
      ], links, { tag: "Packing slips" }),
    };
  }

  const counts = packetCounts({ slips, revised, cancelled });
  const title = sunday
    ? `Packing slips for the week of ${when}: ${counts}`
    : `Packing slips, ${when}: ${counts}`;

  return {
    subject: title,
    ...render(title, [
      p(`Print the attached PDF${filename ? `, ${filename}` : ""}. It ` +
        "opens with the pick list for every slip in it."),
      sunday
        ? p(`It's Sunday, so it has a slip for every order due by ${
          label(addDays(day, 6))}, as well as anything new, changed or ` +
          "cancelled since yesterday, and replaces every earlier slip for " +
          "this week.")
        : null,
      revised || cancelled
        ? p("A **revised** order has a sheet saying what changed, then a " +
          "new slip: throw away its old one. A **CANCELLED** order has a " +
          "sheet and no slip.")
        : null,
      heading("In this packet"),
      list(entries.map(packetLine)),
      adminFooter(links),
    ].filter(Boolean), links, { tag: "Packing slips" }),
  };
};

// An order due today that changed after this morning's packet. The
// sheets are attached. Wording is a draft.
export const farmChangedAfterPrint = (entry, { date, links } = {}) => {
  const id = entry.order.id;
  const cancelled = entry.kind === "cancelled";
  const title = cancelled
    ? `Cancelled after printing: ${id}`
    : `Changed after printing: ${id}`;
  const blocks = [
    p(cancelled
      ? `**${id}** is due today, ${label(date)}, and was cancelled after ` +
        "this morning's packing slips went out. Don't pack it. The " +
        "attached sheet says so for the packing table."
      : `**${id}** is due today, ${label(date)}, and changed after this ` +
        "morning's packing slips went out. The attached PDF has a sheet " +
        "saying what changed and a new slip: throw away the old one."),
  ];

  if (!cancelled && entry.changes.length) {
    blocks.push(heading("What changed"), list(entry.changes));
  }
  blocks.push(adminFooter(links));

  return {
    subject: title,
    ...render(title, blocks, links, { tag: "Packing slips" }),
  };
};

// A short line for the CLI and logs.
export const summaryLine = (order) =>
  `${order.id} ${order.status} ${dollars(order.totals.total)} ` +
  `${methodName(order.fulfilment.method)} ${order.fulfilment.date} ` +
  `${order.customer.email}`;
