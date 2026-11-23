// The cart's figures (docs/refactors/cart.md, phase 2): the readouts
// in the pane and the bars, the sums, a paid order's money, the
// shared row's switch and the nudge. plan.mjs decides what they say.

import { all, pulse, qs } from "./dom.js";
import { editMoney, readoutLabels, wayButtons } from "./plan.mjs";

// The readouts, in the pane and in the bars. `parts` holds the
// cart's `root`, the `form` the bars are in, and the `pill`.
export const drawReadouts = ({ root, form, pill }, s) => {
  const labels = readoutLabels(s);

  qs(root, "[data-cart-count]").textContent = s.countText;
  for (const el of all(form, "[data-total-bar-count]")) {
    el.textContent = s.countText;
  }
  for (const el of all(form, "[data-total-bar-total]")) {
    el.textContent = s.total;
  }
  for (const el of all(form, "[data-to-cart]")) {
    el.setAttribute("aria-label", labels.link);
  }
  pill.setAttribute("aria-label", labels.pill);
};

const drawDiscount = (root, s) => {
  qs(root, "[data-total-row='discount']").hidden = !s.discount;
  qs(root, "[data-total='discount-label']").textContent =
    s.discount ? s.discount.label : "";
  qs(root, "[data-total='discount']").textContent =
    s.discount ? s.discount.text : "";
};

const drawFee = (root, s) => {
  const fee = qs(root, "[data-total='fee']");

  qs(root, "[data-total-row='fee']").hidden = !s.fee.show;
  fee.textContent = s.fee.show ? s.fee.text : "";
  fee.classList.toggle("order-cart-free", !!s.fee.waived);
};

// The sums. The total bumps when it changed from `lastTotal`, the one
// drawn last (null before the first).
export const drawSums = (root, s, lastTotal) => {
  qs(root, "[data-total='subtotal']").textContent = s.subtotal;
  drawDiscount(root, s);
  drawFee(root, s);

  const total = qs(root, "[data-total='total']");

  if (lastTotal !== null && lastTotal !== s.total) {
    pulse(total, "is-bumped");
  }
  total.textContent = s.total;
};

// Changing a paid order (editMoney), or nothing when `edit` is null.
export const drawEdit = (root, edit) => {
  const box = qs(root, "[data-edit-money]");

  box.hidden = !edit;
  if (!edit) return;

  const money = editMoney(edit);

  qs(box, "[data-total='paid']").textContent = money.paid;
  qs(box, "[data-edit-kept]").hidden = !edit.kept;
  qs(box, "[data-total='kept']").textContent = money.kept;
  if (edit.kept) {
    qs(box, "[data-total='kept-label']").textContent = money.keptLabel;
  }
  qs(box, "[data-total='due-label']").textContent = money.dueLabel;
  qs(box, "[data-total='due']").textContent = money.due;
};

// The shared row's switch and its button's name (wayButtons). Only
// the method (#352): the day, time and place stay in the method's
// card.
export const drawWays = (root, method, ways) => {
  const els = all(root, "[data-way]");
  const choices = els.map((el) => ({
    way: el.dataset.way, name: el.textContent.trim(),
  }));
  const { buttons, name } = wayButtons({ method, ways, choices });

  buttons.forEach(({ pressed, disabled }, i) => {
    els[i].setAttribute("aria-pressed", String(pressed));
    els[i].classList.toggle("btn-primary", pressed);
    els[i].classList.toggle("btn-outline-primary", !pressed);
    els[i].disabled = disabled;
  });
  qs(root, "[data-way-name]").textContent = name;
};

// The nudge under the foot's buttons, with the rest of the change
// (#559): set after the motion had read the sizes, its line came or
// went in one frame while the other parts eased.
export const drawNudge = (root, s) => {
  const nudge = qs(root, "[data-nudge]");

  if (nudge.textContent !== s.nudge) nudge.textContent = s.nudge;
  nudge.hidden = !s.nudge;
  nudge.dataset.tone = s.nudgeTone || "";
};
