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
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import { addDays, label } from "../../../assets/scripts/order/lib/zoned.mjs";
import { GUIDE, RUNBOOK_ALERTS } from "./alerts-guide.mjs";
import { company } from "./company.mjs";
import { between, methodName } from "./describe.mjs";
import { needsAgreement, paymentsOf } from "./records.mjs";

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
const strong = (text) => p(`**${text}**`);
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

// A figure that wants attention: bold, in the site's danger red.
const alarm = (text) => ({
  text: `**${text}**`,
  html: `<strong style="color:#b02a37">${escape(text)}</strong>`,
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

const totalsBlock = (order) => {
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
  items.push(`Total ${dollars(t.total)}`);

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

// "9 – 11 AM", "11 AM – 1 PM": a confirmed pickup range, on the hour.
const hoursRange = (from, to) => {
  const h = (x) => `${((x + 11) % 12) + 1}`;
  const m = (x) => (x < 12 ? "AM" : "PM");

  return m(from) === m(to)
    ? `${h(from)} – ${h(to)} ${m(to)}`
    : `${h(from)} ${m(from)} – ${h(to)} ${m(to)}`;
};

// "morning" until the farm has confirmed a range inside it, then
// "9 – 11 AM (morning)".
const pickupWindow = (order) => {
  const o = order.fulfilment.onfarm || {};

  return o.confirmed && !needsAgreement(order)
    ? `${hoursRange(o.confirmed.from, o.confirmed.to)} (${o.window})`
    : o.window;
};

// "84 Foster Center Rd, Foster, RI 02825", skipping whatever the
// record lacks.
const streetAddress = (a = {}) => [
  a.address1, a.address2, a.town,
  [a.state, a.zip].filter(Boolean).join(" "),
].filter(Boolean).join(", ");

// "Order type: Delivery" and the two lines under it. An on-farm
// window the farm has not agreed to yet is "Requested:", not "When:".
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
        `${needsAgreement(order) ? "Requested" : "When"}: ${when}, ${
          pickupWindow(order)}`,
        `Where: ${terms.onFarm.address}`,
      ];

  return [p(`Order type: **${methodName(f.method)}**`), list(items)];
};

// The pickup window two ways: "Thursday, October 8, morning" for a
// labelled line, "the morning of Thursday, October 8" in a sentence.
const windowPhrase = (order) =>
  `${label(order.fulfilment.date)}, ${order.fulfilment.onfarm.window}`;

const timeOf = (order) =>
  `the ${order.fulfilment.onfarm.window} of ${label(order.fulfilment.date)}`;

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

// Sent when the order is both paid and, for an on-farm pickup, agreed:
// by whichever of the two arrives second. Square sends the receipt,
// so this one does not price anything either.
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

// An on-farm order paid before the farm has agreed to the window.
export const paymentReceived = (order, { orderUrl, links } = {}) => {
  const title = "Payment received";
  const blocks = [
    p(`Thanks, ${firstName(order.customer)}. Your payment of ` +
      `${dollars(order.totals.total)} came through.`),
    p("We're checking the schedule to make sure we can accommodate your " +
      "requested pick-up time, and will confirm it by " +
      `${label(addDays(order.fulfilment.date, -1))}.`),
    ...orderDetails(order),
  ];

  if (orderUrl) blocks.push(button("View or edit this order", orderUrl));
  blocks.push(customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// The farm denied the requested window. `reason` is the farm's own
// words from the command line, or empty; `pickUrl` signs the customer
// in to the order page, and is null while the account pages are off,
// when the customer answers by replying instead.
export const pickNewTime = (order, { reason = "", pickUrl, links } = {}) => {
  const title = "One more step: pick a new pickup time";
  const blocks = [
    p(`Hi ${firstName(order.customer)},`),
    strong(`${capital(timeOf(order))} doesn't work for us.`),
  ];

  if (reason) blocks.push(p(`Here's why: _**${reason}**_`));
  if (pickUrl) {
    blocks.push(
      p("Please pick another day or window, and we'll be in touch to " +
        "confirm. If rescheduling isn't an option, you can cancel your " +
        "order from the same page for a full refund."),
      button("Pick a new time", pickUrl)
    );
  } else {
    blocks.push(p("Please reply with another day or window, and we'll be " +
      "in touch to confirm. If rescheduling isn't an option, reply and " +
      "we'll cancel your order for a full refund."));
  }
  blocks.push(...orderDetails(order), customerFooter(links));

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

// After a customer changes the date or details of an order.
export const orderChanged = (order, { orderUrl, links } = {}) => {
  const title = "Your order is updated";
  const f = order.fulfilment;
  const notes = instructions(order);
  const blocks = [
    p(`${firstName(order.customer)}, here's your current order.`),
    orderNumber(order),
    lines(order),
    ...orderType(order),
  ];

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

// After a cancellation, by the customer or the farm.
export const orderCancelled = (order, {
  refund = false, links,
} = {}) => {
  const title = "Your order is cancelled";
  const blocks = [p(`Hi ${firstName(order.customer)},`)];

  if (refund) {
    blocks.push(
      p(`We cancelled your order for ${
        methodName(order.fulfilment.method).toLowerCase()} on ${
        label(order.fulfilment.date)}.`),
      p("**Your refund is on its way.** Most refunds arrive within a " +
        "few business days.")
    );
  } else {
    blocks.push(p("We cancelled your order. Nothing more will be charged."));
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
    blocks.push(p(`We looked at ${where} and it's farther than we can ` +
      "drive on a Thursday. On-farm pickup and the drop site are " +
      "open to everyone, with no minimum and no fee."));
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

// Farm news: the one click that puts an address on the list. Sent to
// anyone who asks on the site, and to the old list when it is asked
// to opt in again. Nothing else is ever sent before that click. The
// wording is James's, on the pattern of the sign-in email.
export const newsConfirm = (email, url, { days = 7, links } = {}) => {
  const title = "Confirm your email for North Foster Farm news and updates";
  const blocks = [
    p("Click the button below to receive news and updates from North " +
      "Foster Farm."),
    button("Sign up", url),
    p(`This link expires in ${days} days. If you didn't request this ` +
      "email, you can safely ignore it."),
    row([["Need help? Contact us", contactUrl(links)]]),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// --- To the farm ---------------------------------------------------
//
// These are the farm's notice of an order. They go to ADMIN_EMAILS
// and link into the admin dashboard; the pages they point at arrive
// with the dashboard's order views.

const CONTACT_WORD = { text: "prefers a text", call: "prefers a call" };

const adminUrl = (links, path) =>
  (links && links.admin ? `${links.admin}/${path}` : null);

const customerUrl = (links, email) =>
  adminUrl(links, `customers/${encodeURIComponent(email || "")}`);

const orderAdminUrl = (links, id) =>
  adminUrl(links, `orders/${encodeURIComponent(id)}`);

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

// The two commands that settle a requested pickup window. The farm's
// "New order" notice is the queue, so it carries them.
const confirmOrDeny = (order) => {
  const window = order.fulfilment.onfarm.window;
  const bounds = (terms.onFarm.windows || {})[window] || {};
  const h24 = (h) => `${h}:00`;
  const from = bounds.from;
  const to = bounds.to;
  const example = Math.min(from + 1, to - 2);

  return [
    p(`They asked for the ${window}, which runs ${h24(from)} to ${h24(to)}. ` +
      "Confirming with no hours tells them you'll be there for the first " +
      `two hours of it, ${h24(from)} to ${h24(from + 2)}:`),
    command(`bin/nff orders confirm ${order.id}`),
    p("To be there at other hours inside that window, give the start on " +
      "the 24-hour clock with --at (two hours from there), and the end " +
      `with --until if it is not two hours later. ${h24(example)} to ${
        h24(example + 2)}, then ${h24(example)} to ${h24(to)}:`),
    command(`bin/nff orders confirm ${order.id} --at ${example}`),
    command(`bin/nff orders confirm ${order.id} --at ${example} --until ${to}`),
    p("Or deny the window and they pick another day or window. What you " +
      "give as the reason goes to them in that email, in your words:"),
    command(`bin/nff orders deny ${order.id} --reason "..."`),
  ];
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
  if (needsAgreement(order)) {
    blocks.push(
      p("Pickup time: **Requested, not yet confirmed**"),
      ...confirmOrDeny(order)
    );
  }
  blocks.push(p(`Paid: **${paymentPhrase(order)}**`));
  if (squareUrl) blocks.push(button("View order in Square", squareUrl));
  blocks.push(adminFooter(links));

  return {
    subject: title, ...render(title, blocks, links, { tag: "New order" }),
  };
};

// The customer moved an on-farm order to another day or window from
// their account page, so the farm has to agree to it again.
export const farmPickupChanged = (order, { links } = {}) => {
  const c = order.customer;
  const title = `Pickup time to confirm: ${order.id}`;
  const url = orderAdminUrl(links, order.id);
  const blocks = [
    p(`${c.name || c.email} moved order ${order.id} to a new pickup ` +
      "time. It needs confirming again."),
    p(`Requested: **${windowPhrase(order)}**`),
    ...confirmOrDeny(order),
  ];

  if (url) blocks.push(button("View order", url));
  blocks.push(adminFooter(links));

  return {
    subject: title,
    ...render(title, blocks, links, { tag: "Pickup time to confirm" }),
  };
};

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
    {
      text: `\n${message.message}\n`,
      html: `<blockquote style="margin:16px 0;padding:8px 16px;` +
        `border-left:3px solid ${GREEN};white-space:pre-wrap">${
          escape(message.message)}</blockquote>`,
    },
  ];
  const url = order ? orderAdminUrl(links, message.orderId) : null;

  if (url) blocks.push(button("View order", url));
  blocks.push(adminFooter(links));

  return {
    subject: title,
    ...render(title, blocks, links, { tag: "Message from the website" }),
  };
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
const BAD = "🤮";
const PLAIN = "🫥";
const within = (ok) => (ok ? GOOD : BAD);
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
  date, links, now = new Date(),
} = {}) => {
  const title = `Morning report: ${label(date)}`;
  const blocks = [
    heading("Vital signs: the last 24 hours"),
    p("How the site did since yesterday's report. " +
      `${GOOD} within healthy limits, ${BAD} outside them, ${PLAIN} a ` +
      "number with no limits, just worth knowing. Anything marked " +
      `${BAD} is worth a look, and an alert will usually have said so ` +
      "already."),
    table(["", "Last 24 h", ""],
      VITALS.map(([key, name, judge]) => [name, String(stats[key]),
        judge(stats)]),
      { align: ["left", "right", "center"] }),
  ];

  if (pickups.length) {
    blocks.push(
      heading("Pickups to confirm"),
      p("These on-farm pickups are within two days and not confirmed, " +
        "oldest order first."),
      table(["Order", "Customer", "Requested", "Waiting", "Status"],
        pickups.slice().sort((a, b) => (a.submittedAt < b.submittedAt
          ? -1 : 1)).map((o) => [
          mono(o.id),
          o.customer.name || o.customer.email,
          windowPhrase(o),
          age(o.submittedAt, now),
          o.question && !o.question.answeredAt
            ? alarm("denied, not re-picked") : "to confirm",
        ])),
      p("Confirm one by its order number, or run the command with no " +
        "number to be shown how many wait and the oldest of them:"),
      command("bin/nff orders confirm <id>"),
      command("bin/nff orders confirm")
    );
  } else {
    blocks.push(p("No pickups waiting on a decision."));
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
      const agreed = needsAgreement(o)
        ? `${o.fulfilment.onfarm.window}, NOT CONFIRMED`
        : `${pickupWindow(o)}, confirmed`;

      blocks.push(p(`**${o.id}**, ${who(o)}, ${agreed}, ${state(o)}`),
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
