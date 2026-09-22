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
import { cutoffFor } from "../../../assets/scripts/order/lib/dates.mjs";
import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import {
  addDays, label, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { company } from "./company.mjs";
import { between, methodName, whenWhere } from "./describe.mjs";
import { needsAgreement } from "./records.mjs";

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
const link = (text, url) => ({
  text: `${text}: ${url}`,
  html: `<p><a href="${escape(url)}" style="color:${GREEN}">` +
    `${escape(text)}</a></p>`,
});

// The site's .btn-primary and .btn-outline-primary, inlined.
const BTN = "display:inline-block;padding:8px 16px;border-radius:4px;" +
  "font-weight:bold;line-height:1.5;text-decoration:none;";
const button = (text, url, { outline = false } = {}) => {
  const look = outline
    ? `border:1px solid ${GREEN};color:${GREEN};background:#fff`
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
// A small table: aligned columns in text, a plain <table> in HTML.
const CELL = "padding:4px 14px 4px 0;vertical-align:top;text-align:left";
const table = (headers, rows) => {
  const widths = headers.map((h, i) => Math.max(
    h.length, ...rows.map((r) => String(r[i]).length)
  ));
  const line = (cells) => cells
    .map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
  const cell = (tag, c, extra = "") =>
    `<${tag} style="${CELL}${extra}">${escape(c)}</${tag}>`;

  return {
    text: [line(headers), ...rows.map(line)].join("\n"),
    html: `<table style="border-collapse:collapse;margin:12px 0;` +
      `font-size:15px"><thead><tr>${headers.map((h) =>
        cell("th", h, ";border-bottom:1px solid rgba(0,0,0,.175)"))
        .join("")}</tr></thead><tbody>${rows.map((r) =>
        `<tr>${r.map((c) => cell("td", c)).join("")}</tr>`).join("")
      }</tbody></table>`,
  };
};
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

// The subject is the title; the body does not repeat it.
const render = (title, blocks, links = {}) => {
  const text = [title, "", ...blocks.map((b) => b.text), "", footer.text]
    .join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width">` +
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
      blocks.map((b) => b.html).join("")
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

// Money is the invoice's job, so customer messages list what was
// ordered without pricing it.
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
    items.push(t.deliveryFee
      ? `Delivery fee +${dollars(t.deliveryFee)}`
      : "Delivery fee waived");
  }
  items.push(`Total ${dollars(t.total)}`);

  return list(items);
};

const payUrl = (order) => (order.square && order.square.invoiceUrl) || "";

const orderNumber = (order) => p(`Order number: **${order.id}**`);

const clock = (hour) => `${((hour + 11) % 12) + 1} ${hour < 12 ? "AM" : "PM"}`;

const daysApart = (fromIso, toIso) => Math.round(
  (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`))
  / 86_400_000
);

// A delivery is kept only by paying before the Wednesday-noon cutoff,
// so the reminders name it. -> null for a pickup, which has no cutoff
// worth a sentence. `days` is how many days off that Wednesday is.
const deliveryCutoff = (order, now) => {
  if (order.fulfilment.method !== "delivery") return null;

  const at = cutoffFor(order.fulfilment.date, terms);
  const date = today(at, terms.timeZone);

  return {
    date,
    day: label(date).split(",")[0],
    at: clock(terms.delivery.cutoffHour),
    days: daysApart(today(now, terms.timeZone), date),
  };
};

// "today", "tomorrow", "on Wednesday", or the full date a week or
// more out.
const onDay = (days, day, date) => {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";

  return `on ${days < 7 ? day : label(date)}`;
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
          f.onfarm.window}`,
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

// The Venmo alternative, under the Square button in every pay link.
// The customer presses "I paid by Venmo" on the order page, or, while
// the account pages are off, replies. Nothing when the farm has no
// Venmo handle in company.json.
const venmoOffer = (order, orderUrl) => (company.venmo
  ? p(`To pay by Venmo instead, send ${dollars(order.totals.total)} to ` +
    `@${company.venmo} with ${order.id} in the note. Then ${orderUrl
      ? "click \"I paid by Venmo\" on your order page"
      : "reply to this email"} so we know to look for it.`)
  : null);

// Sent the moment the invoice is published, and again when the
// customer asks for it (resendInvoice). The invoice itemizes and
// totals the money, so this only names what was ordered. An on-farm
// window is a request the farm has still to agree to, and paying does
// not confirm it, so that version says so and promises the
// confirmation separately. `orderUrl` is the order page (or a sign-in
// link to it, for a guest who looked the order up).
export const completeYourOrder = (order, { orderUrl, links } = {}) => {
  const title = "One more step: pay for your order";
  const total = dollars(order.totals.total);
  const blocks = [
    p(`Hi ${firstName(order.customer)},`),
    strong("Your order isn't final until it's paid."),
  ];

  if (needsAgreement(order)) {
    blocks.push(
      p(`Here's your invoice for ${total}. Pay it to complete your ` +
        "checkout."),
      button("Pay and complete your checkout", payUrl(order)),
      ...[venmoOffer(order, orderUrl)].filter(Boolean),
      p("We'll check to make sure we can accommodate your requested " +
        "pick-up time, and confirm it in a separate email. Nothing else " +
        "needed from you until then.")
    );
  } else {
    blocks.push(
      p(`Here's your invoice for ${total}. Pay it to complete your ` +
        "checkout and confirm your order."),
      button("Pay and confirm your order", payUrl(order)),
      ...[venmoOffer(order, orderUrl)].filter(Boolean)
    );
  }
  blocks.push(...orderDetails(order));
  if (orderUrl) {
    blocks.push(button("View or edit this order", orderUrl, { outline: true }));
  }
  blocks.push(customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
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

  if (orderUrl) blocks.push(button("View or edit this order", orderUrl));
  blocks.push(customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// An on-farm order paid before the farm has agreed to the window.
export const paymentReceived = (order, { orderUrl, links } = {}) => {
  const title = "Payment received";
  const blocks = [
    p(`Thanks, ${firstName(order.customer)}. Your payment of ` +
      `${dollars(order.totals.total)} came through. We're checking the ` +
      "schedule to make sure we can accommodate your requested pick-up " +
      `time, and will confirm it by ${
        label(addDays(order.fulfilment.date, -1))}.`),
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
  const paid = order.status === "paid";
  const blocks = [
    p(`Hi ${firstName(order.customer)},`),
    strong(`${capital(timeOf(order))} doesn't work for us.`),
  ];

  if (reason) blocks.push(p(`Here's why: _**${reason}**_`));
  if (pickUrl) {
    blocks.push(
      p("Please pick another day or window, and we'll be in touch to " +
        "confirm. If rescheduling isn't an option, you can cancel your " +
        "order from the same page."),
      button("Pick a new time", pickUrl)
    );
  } else {
    blocks.push(p("Please reply with another day or window, and we'll be " +
      "in touch to confirm. If rescheduling isn't an option, reply and " +
      "we'll cancel your order."));
  }
  if (!paid) {
    blocks.push(p("Payment reminders are paused until you've picked."));
  }
  blocks.push(...orderDetails(order), customerFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// Unpaid reminders: soon after placing, the next day, and a final one
// the Wednesday before delivery.
export const paymentReminder = (order, stage, {
  orderUrl, settingsUrl, links, now = new Date(),
} = {}) => {
  const total = dollars(order.totals.total);
  const cutoff = deliveryCutoff(order, now);
  const titles = {
    soon: "Still waiting for payment",
    nextDay: "Your order is waiting for payment",
    final: "Last call: your unpaid order will be cancelled",
  };
  const title = titles[stage] || titles.soon;
  const blocks = [p(`Hi ${firstName(order.customer)},`)];

  if (stage === "final") {
    blocks.push(strong("Your order will be cancelled and marked " +
      "abandoned in your order history, unless you submit your payment " +
      "today."));
    if (cutoff) {
      const days = daysApart(today(now, terms.timeZone),
        order.fulfilment.date);

      blocks.push(p(`Your invoice for ${total} is still unpaid. Pay ` +
        `before ${cutoff.at} ${onDay(cutoff.days, cutoff.day, cutoff.date)} ` +
        `to receive your delivery ${
          onDay(days, label(order.fulfilment.date).split(",")[0],
            order.fulfilment.date)}.`));
    } else {
      blocks.push(p(`Your invoice for ${total} is still unpaid, and ` +
        `${whenWhere(order).charAt(0).toLowerCase()}${
          whenWhere(order).slice(1)} is coming up. Pay now to keep your ` +
        "spot."));
    }
  } else if (stage === "nextDay") {
    blocks.push(p(`Your invoice for ${total} from yesterday hasn't been ` +
      "paid yet. **Your order isn't final until we receive your " +
      "payment.**"));
    if (cutoff) {
      blocks.push(p(`Confirm your order by ${cutoff.at} ${
        onDay(cutoff.days, cutoff.day, cutoff.date)} to keep your delivery ` +
        "appointment."));
    }
  } else {
    blocks.push(p("You placed an order about an hour ago, and the " +
      `invoice for ${total} is still open. **Your order isn't final ` +
      "until it's paid.**"));
  }

  blocks.push(
    button("Pay and confirm your order", payUrl(order)),
    ...orderDetails(order)
  );
  if (orderUrl) {
    blocks.push(button("View or cancel this order", orderUrl,
      { outline: true }));
  }
  if (settingsUrl) {
    blocks.push(link("Turn off payment reminders", settingsUrl));
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
    blocks.push(link("Turn off delivery reminders", settingsUrl));
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
    blocks.push(p("We cancelled your order. Your invoice is closed and " +
      "you were not charged."));
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
    blocks.push(p(`We looked at ${where} and it's further than we can ` +
      "drive on a Thursday. On-farm pickup and the Scituate drop site " +
      "are open to everyone, with no minimum and no fee."));
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

// --- To the farm ---------------------------------------------------
//
// Square tells the farm nothing about an invoice the farm's own
// account issued, so these are the only notice of an order. They go
// to ADMIN_EMAILS and link into the admin dashboard; the pages they
// point at arrive with the dashboard's order views.

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
export const addressReview = (customer, { cliHint, links } = {}) => {
  const a = customer.address || {};
  const who = customer.name || customer.email;
  const url = customerUrl(links, customer.email);
  const title = `Address to review: ${who}`;
  const blocks = [
    url
      ? {
        text: `${who} (${url}) saved an address outside of the ` +
          "published delivery area.",
        html: `<p><a href="${escape(url)}">${escape(who)}</a> saved an ` +
          "address outside of the published delivery area.</p>",
      }
      : p(`${who} (${customer.email}) saved an address outside of the ` +
        "published delivery area."),
    p(`Location: **${streetAddress(a)}**`),
    button("View location in Maps", mapsUrl(a)),
  ];

  if (cliHint) blocks.push(p(`Approve or deny it: ${cliHint}`));
  blocks.push(adminFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

const customerDetails = (order, links) => {
  const c = order.customer;
  const word = CONTACT_WORD[c.contact];
  const items = [c.name || c.email, c.email];

  if (c.phone) items.push(`${c.phone}${word ? `, ${word}` : ""}`);

  const blocks = [heading("Customer details"), list(items)];
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
const confirmOrDeny = (order) => [
  p(`Confirm it: bin/nff orders confirm ${order.id}`),
  p(`Or deny it and they pick again: bin/nff orders deny ${order.id} ` +
    "--reason \"...\""),
];

const paidWord = (order) => (order.status === "paid" ? "paid" : "unpaid");

// The moment an order is placed, paid or not.
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
    orderNumber(order),
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
  blocks.push(p("Invoice status: **Sent, unpaid**"));
  if (squareUrl) blocks.push(button("View invoice in Square", squareUrl));
  blocks.push(adminFooter(links));

  return { subject: title, ...render(title, blocks, links) };
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

  return { subject: title, ...render(title, blocks, links) };
};

// The customer pressed "I paid by Venmo" before Venmo's notification
// reached the site, or the note had no order number in it.
export const farmVenmoClaimed = (order, { links } = {}) => {
  const c = order.customer;
  const total = dollars(order.totals.total);
  const title = `Venmo to check: order ${order.id} — ${total}`;
  const url = orderAdminUrl(links, order.id);
  const who = c.name || c.email;
  const blocks = [
    p(`${who} clicked "I paid by Venmo" on order ${order.id}.`),
    p(`Open the Venmo app and look in the farm's transactions for **${
      total} from ${who} with ${order.id} in the note**. Venmo's own ` +
      "email usually reaches the site first and marks the order paid by " +
      "itself; this notice means it hasn't yet, or the note had no order " +
      "number."),
    p("If the payment is there, mark the order paid. That sends the " +
      "customer's confirmation and closes the Square invoice so it can't " +
      `be paid twice: bin/nff orders paid ${order.id} --via venmo`),
    p("If it never arrives, lift the hold so the payment reminders and " +
      `the cutoff run again: bin/nff orders unpaid ${order.id}`),
    p("Until one of those runs, the order waits: no reminders, and not " +
      "cancelled at the cutoff."),
  ];

  if (url) blocks.push(button("View order", url));
  blocks.push(adminFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// The evening report of Venmo payments the site could not apply: no
// order number in the note, or an amount that is not the order's
// total. Sent only when there is at least one.
export const farmVenmoUnmatched = (payments, { date, links } = {}) => {
  const title = `Venmo payments with no order: ${label(date)}`;
  const blocks = [
    p("These Venmo payments arrived with no order number in the note, " +
      "or an amount that isn't the order's total. Market sales will show " +
      "here. Anything else may be an online order whose note left out " +
      "the number."),
    table(["Amount", "From", "Note", "Order"], payments.map((v) => [
      dollars(v.cents),
      v.payer,
      v.note || "(none)",
      v.orderId
        ? `${v.orderId} (${v.orderTotal !== null
          ? `${dollars(v.orderTotal)} due` : "no such order"})`
        : "",
    ])),
    p("The full record, with Venmo's transaction ids: bin/nff venmo list"),
    adminFooter(links),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// The morning report of on-farm orders within two days of their date
// whose window is still unconfirmed, or denied and not yet re-picked.
// Sent only when there is at least one.
export const farmPickupsToConfirm = (orders, { date, links } = {}) => {
  const title = `Pickups to confirm: ${label(date)}`;
  const blocks = [
    p("These on-farm pickups are within two days and not confirmed."),
    list(orders.map((o) => `${o.id}, ${o.customer.name || o.customer.email}` +
      `, ${windowPhrase(o)}, ${paidWord(o)}${
        o.question && !o.question.answeredAt
          ? ", denied and not re-picked" : ""}: bin/nff orders confirm ${
        o.id}`)),
    adminFooter(links),
  ];

  return { subject: title, ...render(title, blocks, links) };
};

// When the invoice clears, from the webhook or the 15-minute poll.
export const farmOrderPaid = (order, { squareUrl, links } = {}) => {
  const title = `Paid: order ${order.id} — ${dollars(order.totals.total)}`;
  const url = orderAdminUrl(links, order.id);
  const blocks = [p("Payment received.")];

  if (url) blocks.push(button("View order", url));
  if (squareUrl) blocks.push(button("View invoice in Square", squareUrl));
  blocks.push(adminFooter(links));

  return { subject: title, ...render(title, blocks, links) };
};

// A short line for the CLI and logs.
export const summaryLine = (order) =>
  `${order.id} ${order.status} ${dollars(order.totals.total)} ` +
  `${methodName(order.fulfilment.method)} ${order.fulfilment.date} ` +
  `${order.customer.email}`;
