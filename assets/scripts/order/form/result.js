// The result panels (docs/refactors/order-form.md, phase 4): the
// order placed, a checkout that could not complete, and a change the
// server refused. placed.mjs says what each says. `view` is what the
// panels draw on, from the form: `form`, `pending`, `result`, the
// farm's `contact`, the placed words' `ctx`, whether the customer is
// `signedIn`, the offered `group`, and `item(sku)` and `total()` for
// the summary.

import { qs } from "./dom.js";
import {
  contactHrefs, dateTime, failureBeacon, isRound, paidWith, pickupAddress,
  summaryText,
} from "./placed.mjs";
import { dollars } from "../lib/totals.mjs";

const panel = (id) => document.getElementById(id).content.cloneNode(true);

// The panel, in place of the pending one, brought into view.
const finish = (view, node) => {
  view.pending.hide();
  view.result.textContent = "";
  view.result.appendChild(node);
  view.result.hidden = false;
  view.result.scrollIntoView({ block: "start", behavior: "smooth" });
};

// The farm's own address and number in a card, from the page's data,
// each a link only when it is a plain one (contactHrefs).
const contactLinks = (node, contact, subject, body) => {
  const mail = qs(node, "[data-out='mailto']");
  const phone = qs(node, "[data-out='phone']");
  const { mailto, tel } = contactHrefs(contact, subject, body);

  if (mailto) mail.href = mailto;
  mail.textContent = contact.email;
  if (tel) phone.href = tel;
  phone.textContent = contact.phone.display;
};

// The placed panel's rows (#723). The order type is the way's title
// as its card on the form shows it; a draft saved before scheduled
// pickup (`scituate`) is a pickup day, and a group's round a Group
// order.
const orderType = (f, group) => {
  if (isRound(f, group)) return "Group orders";

  const way = f.method === "scituate" ? "scheduled" : f.method;
  const title = document.getElementById(`method-${way}-title`);

  return title ? title.textContent.trim() : "";
};

// A delivery has no pick-up address: the row goes, not hidden.
const fillAddress = (node, view, f, fill) => {
  const row = qs(node, "[data-out='addressRow']");
  const address = row
    && pickupAddress(f, { ...view.ctx, farm: row.dataset.farm });

  if (address) {
    fill("address", address);
  } else if (row) {
    row.remove();
  }
};

const fillAccount = (node, signedIn, payment) => {
  const signIn = qs(node, "[data-out='signIn']");

  if (signIn) signIn.hidden = signedIn;

  const signedInRow = qs(node, "[data-out='signedIn']");

  if (signedInRow) signedInRow.hidden = !signedIn;

  const receipt = qs(node, "[data-out='receiptUrl']");

  if (payment && payment.receiptUrl) {
    receipt.href = payment.receiptUrl;
  } else {
    receipt.parentElement.hidden = true;
  }
};

const fillPlaced = (node, view, data, fill) => {
  fill("name", data.customer.firstName || data.customer.name);
  fill("email", data.customer.email);
  fill("total", dollars(data.totals.total));
  fill("orderId", data.orderId);
  fill("how", paidWith(data.payment));
  fill("type", orderType(data.fulfilment, view.group));
  fill("dateTime", dateTime(data.fulfilment, view.ctx));
  fillAddress(node, view, data.fulfilment, fill);
  fillAccount(node, view.signedIn, data.payment);
};

// The order is placed. Dropped silently by the server (no `data`):
// show nothing that could be used to probe the filter, just a plain
// thank-you.
export const showPlaced = (view, data, payload) => {
  const node = panel("order-success");
  const fill = (name, text) => {
    const el = qs(node, `[data-out="${name}"]`);

    if (el) el.textContent = text;
  };

  if (data) {
    fillPlaced(node, view, data, fill);
  } else {
    fill("name", payload.customer.firstName);
    qs(node, "[data-out='details']").hidden = true;
  }

  view.form.hidden = true;
  finish(view, node);
};

// A change the server refused: the order can no longer be changed
// (#643). Nothing went wrong on our end, so no summary to send and
// no word to the farm. `subject` names the order; `clear` clears the
// change's draft, just before the card goes in.
export const showLocked = (view, message, subject, clear) => {
  const node = panel("order-locked");

  qs(node, "[data-out='message']").textContent = message;
  contactLinks(node, view.contact, subject);
  clear();
  finish(view, node);
};

const wireCopy = (copy, text) => {
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy summary"; }, 2000);
    } catch {
      copy.textContent = "Select the text above to copy it";
    }
  });
};

// Tell the farm a checkout could not complete. A beacon survives the
// page being closed; nothing here can fail the customer.
const sendBeacon = (payload, message) => {
  try {
    const beacon = JSON.stringify(
      failureBeacon(payload, message, location.pathname)
    );

    if (!navigator.sendBeacon || !navigator.sendBeacon("/api/health",
      new Blob([beacon], { type: "application/json" }))) {
      fetch("/api/health", {
        method: "POST", body: beacon, keepalive: true,
        headers: { "Content-Type": "application/json" },
      }).catch(() => {});
    }
  } catch {
    // The failure itself is already on screen.
  }
};

// A checkout that could not complete: the summary to copy or send.
export const showFailed = (view, payload, message) => {
  const node = panel("order-failed");
  const text = summaryText(payload, {
    ...view.ctx, item: view.item, total: view.total(),
  });

  qs(node, "[data-out='message']").textContent = message;
  qs(node, "[data-out='summary']").textContent = text;
  contactLinks(node, view.contact, "Order from the website", text);
  wireCopy(qs(node, "[data-out='copy']"), text);

  // The key, never the payload: it holds the customer's details, and
  // the console is read by whoever sits down at the machine (#258).
  console.error(JSON.stringify({
    event: "order.undeliverable",
    idempotencyKey: payload && payload.idempotencyKey,
  }));
  sendBeacon(payload, message);
  finish(view, node);
};
