// Every email the farm sends, as pure functions of the record they
// describe. Each returns { subject, text, html }. The text version is
// the source; the HTML wraps the same lines in a plain, brand-green
// header so it reads well in any client and prints the same words.

import { dollars } from "../../../assets/scripts/order/lib/totals.mjs";
import { label } from "../../../assets/scripts/order/lib/zoned.mjs";
import { company } from "./company.mjs";
import { describe, methodName, whenWhere } from "./describe.mjs";

const escape = (s) => String(s)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

// A paragraph, or a bulleted block, or a link. Text and HTML at once.
const p = (text) => ({ text, html: `<p>${escape(text)}</p>` });
const strong = (text) => ({
  text, html: `<p><strong>${escape(text)}</strong></p>`,
});
const link = (text, url) => ({
  text: `${text}: ${url}`,
  html: `<p><a href="${escape(url)}">${escape(text)}</a></p>`,
});
const button = (text, url) => ({
  text: `${text}: ${url}`,
  html: `<p style="margin:24px 0"><a href="${escape(url)}" style="` +
    "display:inline-block;padding:12px 22px;border-radius:10px;" +
    "background:#1c75bc;color:#fff;font-weight:bold;" +
    `text-decoration:none">${escape(text)}</a></p>`,
});
const list = (items) => ({
  text: items.map((i) => `  - ${i}`).join("\n"),
  html: `<ul>${items.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>`,
});

const render = (title, blocks) => {
  const text = [title, "", ...blocks.map((b) => b.text), "", signoff.text]
    .join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:0;` +
    `background:#f5f5f4;font-family:system-ui,-apple-system,Segoe UI,` +
    `Roboto,sans-serif;color:#1d1c1b;line-height:1.55">` +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px">` +
    `<p style="margin:0 0 16px;font-size:13px;font-weight:bold;` +
    `letter-spacing:.08em;text-transform:uppercase;color:#1e7b54">` +
    `${escape(company.name)}</p>` +
    `<div style="background:#fff;border-radius:16px;padding:24px;` +
    `box-shadow:0 1px 3px rgba(0,0,0,.12)">` +
    `<h1 style="margin:0 0 16px;font-size:22px">${escape(title)}</h1>${
      blocks.map((b) => b.html).join("")
    }</div>${signoff.html}</div></body></html>`;

  return { text, html };
};

const signoff = {
  text: `North Foster Farm · ${company.email}${
    company.phone && company.phone.display
      ? ` · ${company.phone.display}` : ""}`,
  html: `<p style="margin:16px 0 0;font-size:13px;color:#5e5e5f">` +
    `North Foster Farm · <a href="mailto:${escape(company.email)}" ` +
    `style="color:#5e5e5f">${escape(company.email)}</a>${
      company.phone && company.phone.display
        ? ` · ${escape(company.phone.display)}` : ""
    }</p>`,
};

const lines = (order) => list(order.lines.map(
  (l) => `${l.qty} × ${l.label} (${dollars(l.lineTotal * 100)})`
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

// Sent the moment the invoice is published.
export const completeYourOrder = (order, { accountUrl } = {}) => {
  const title = `One more step: pay for order ${order.id}`;
  const blocks = [
    p(`Hi ${firstName(order.customer.name)},`),
    strong("Your order isn't final until it's paid."),
    p(`Here's your invoice for ${dollars(order.totals.total)}. Pay it ` +
      "and your order is confirmed."),
    button("Pay your invoice", payUrl(order)),
    p(`${describe(order)}`),
    p("What you ordered:"),
    lines(order),
    totalsBlock(order),
  ];

  if (accountUrl) {
    blocks.push(link("View or change this order", accountUrl));
  }

  return { subject: title, ...render(title, blocks) };
};

// Sent once Square reports the invoice paid.
export const orderConfirmed = (order, { accountUrl } = {}) => {
  const title = `Order ${order.id} is confirmed`;
  const blocks = [
    p(`Thanks, ${firstName(order.customer.name)}. Your payment of ` +
      `${dollars(order.totals.total)} came through and your order is ` +
      "reserved."),
    strong(describe(order)),
    p("What you ordered:"),
    lines(order),
  ];

  if (accountUrl) blocks.push(link("Your orders", accountUrl));

  return { subject: title, ...render(title, blocks) };
};

// Unpaid reminders: soon after placing, the next day, and a final one
// the Wednesday before delivery.
export const paymentReminder = (order, stage, { accountUrl } = {}) => {
  const total = dollars(order.totals.total);
  const titles = {
    soon: `Still need to pay for order ${order.id}?`,
    nextDay: `Your order ${order.id} is waiting for payment`,
    final: `Last call: order ${order.id} will be cancelled unpaid`,
  };
  const title = titles[stage] || titles.soon;
  const blocks = [p(`Hi ${firstName(order.customer.name)},`)];

  if (stage === "final") {
    blocks.push(strong(`If we don't receive payment, this order will be ` +
      "cancelled and marked abandoned in your order history."));
    blocks.push(p(`Your invoice for ${total} is still unpaid, and ` +
      `${whenWhere(order).toLowerCase()} is coming up. Pay now to keep ` +
      "your spot."));
  } else if (stage === "nextDay") {
    blocks.push(p(`Your order from yesterday hasn't been paid yet. It ` +
      "isn't final until it is, so it's not reserved."));
    blocks.push(p(`The invoice is for ${total}.`));
  } else {
    blocks.push(p(`You placed an order a little while ago, and the ` +
      `invoice for ${total} is still open. Your order isn't final ` +
      "until it's paid."));
  }

  blocks.push(button("Pay your invoice", payUrl(order)));
  blocks.push(p(`${whenWhere(order)}.`));
  blocks.push(lines(order));
  if (accountUrl) blocks.push(link("View or cancel this order", accountUrl));

  return { subject: title, ...render(title, blocks) };
};

// Wednesday night, for every paid delivery going out tomorrow.
export const deliveryReminder = (order, { accountUrl } = {}) => {
  const d = order.fulfilment.delivery || {};
  const title = `Your delivery is tomorrow, ${label(order.fulfilment.date)}`;
  const blocks = [
    p(`Hi ${firstName(order.customer.name)},`),
    strong("Please leave a cooler with ice out tomorrow morning."),
    p(`We'll be by between ${whenWhere(order).split(", ").pop()} with:`),
    lines(order),
    p(`Delivering to ${d.address1}${d.address2 ? `, ${d.address2}` : ""}, ` +
      `${d.town} ${d.zip}.`),
    p(`Cooler: ${d.cooler || "wherever you told us"}.${
      d.gate ? ` Gate or keypad: ${d.gate}.` : ""}`),
    p("Chicken arrives frozen and eggs come cold, so the cooler matters."),
  ];

  if (accountUrl) blocks.push(link("Your orders", accountUrl));

  return { subject: title, ...render(title, blocks) };
};

// To the farm, when a customer sets or changes an address outside the
// delivery area.
export const addressReview = (customer, { cliHint } = {}) => {
  const a = customer.address || {};
  const title = `Address to review: ${customer.name || customer.email}`;
  const blocks = [
    p(`${customer.name || "A customer"} (${customer.email}) saved a ` +
      "delivery address outside the approved area."),
    list([
      `${a.address1 || ""}${a.address2 ? `, ${a.address2}` : ""}`,
      `${a.town || ""} ${a.state || ""} ${a.zip || ""}`.trim(),
      `Status: ${a.status || "pending"}`,
    ]),
    p("Approve or deny it and the customer's next delivery order will " +
      "follow your decision."),
  ];

  if (cliHint) blocks.push(p(cliHint));

  return { subject: title, ...render(title, blocks) };
};

// The sign-in link.
export const magicLink = (email, url, { minutes = 15 } = {}) => {
  const title = "Your North Foster Farm sign-in link";
  const blocks = [
    p("Click the button to sign in. The link works once and expires " +
      `in ${minutes} minutes.`),
    button("Sign in", url),
    p(`If you didn't ask for this, ignore it; nothing changes. This ` +
      `was sent to ${email}.`),
  ];

  return { subject: title, ...render(title, blocks) };
};

// After a customer cancels. A paid order is refunded by hand.
export const orderCancelled = (order, { refund = false } = {}) => {
  const title = `Order ${order.id} is cancelled`;
  const blocks = [
    p(`Hi ${firstName(order.customer.name)},`),
    p(`We've cancelled your order for ${whenWhere(order).toLowerCase()}.`),
  ];

  if (refund) {
    blocks.push(strong("Your refund is on its way."));
    blocks.push(p("We refund through Square to the card you paid with; " +
      "it usually shows within a few business days."));
  } else {
    blocks.push(p("The invoice is closed and nothing was charged."));
  }
  blocks.push(p("Changed your mind? You can place a new order any time."));

  return { subject: title, ...render(title, blocks) };
};

// After a customer changes the date or details of an order.
export const orderChanged = (order) => {
  const title = `Order ${order.id} updated`;
  const f = order.fulfilment;
  const details = [];

  if (f.method === "onfarm" && f.onfarm) {
    details.push(`Window: ${f.onfarm.window}`);
  }
  if (f.method === "delivery" && f.delivery) {
    details.push(`Cooler: ${f.delivery.cooler}`);
    if (f.delivery.gate) details.push(`Gate or keypad: ${f.delivery.gate}`);
    if (f.delivery.notes) details.push(`Notes: ${f.delivery.notes}`);
  }
  if (order.notes) details.push(`Order notes: ${order.notes}`);

  const blocks = [
    p(`Hi ${firstName(order.customer.name)}, here's your order as it stands.`),
    strong(`${whenWhere(order)}.`),
  ];

  if (details.length) blocks.push(list(details));
  blocks.push(lines(order));

  return { subject: title, ...render(title, blocks) };
};

// The farm decided on an address outside the usual area.
export const addressDecision = (customer, decision) => {
  const a = customer.address || {};
  const where = `${a.address1 || ""}, ${a.town || ""} ${a.zip || ""}`.trim();
  const approved = decision === "approved";
  const title = approved
    ? "We can deliver to your address"
    : "We can't deliver to your address";
  const blocks = [
    p(`Hi ${firstName(customer.name)},`),
    approved
      ? p(`Good news: ${where} is on our route. Choose local delivery ` +
        "next time you order and it will fill itself in.")
      : p(`We looked at ${where} and it's further than we can drive on a ` +
        "Thursday. On-farm pickup and the Scituate drop site are open to " +
        "everyone, with no minimum and no fee."),
  ];

  return { subject: title, ...render(title, blocks) };
};

// The farm settled a return request.
export const returnResolved = (order, request) => {
  const title = `About your order ${order.id}`;
  const blocks = [
    p(`Hi ${firstName(order.customer.name)},`),
    p(`Thanks for telling us about ${order.id}. We've looked into it.`),
  ];

  if (request.note) blocks.push(strong(request.note));
  blocks.push(p("Reply to this email if there's anything else."));

  return { subject: title, ...render(title, blocks) };
};

// A short line for the CLI and logs.
export const summaryLine = (order) =>
  `${order.id} ${order.status} ${dollars(order.totals.total)} ` +
  `${methodName(order.fulfilment.method)} ${order.fulfilment.date} ` +
  `${order.customer.email}`;
