// The cart's badges and their tooltips, and the perks' line with its
// info buttons (docs/refactors/cart.md, phase 3). Cart builds one,
// wires it with the rest of the pane, and asks it to shut its
// tooltips when the pane folds, settles or scrolls, or on Escape.

import Tooltip from "bootstrap/js/dist/tooltip.js";

import { celebrate } from "../celebrate.js";
import { all, qs } from "./dom.js";
import { drawBadgeInfo, drawPerks } from "./perk-label.js";
import { deliveryTip, tierKeys } from "./plan.mjs";
import { shutTip } from "./tip.js";

// A badge in full view inside the pane, which `root` is.
const seenIn = (root, el) => {
  const r = el.getBoundingClientRect();
  const box = root.getBoundingClientRect();

  return r.height > 0
    && r.top >= Math.max(0, box.top) - 1
    && r.bottom <= Math.min(window.innerHeight, box.bottom) + 1;
};

export class Badges {
  // `root` is #order-cart.
  constructor(root) {
    this.root = root;
    // Which badges were lit at the last render, so a badge that turns
    // on can celebrate. Null until the first render, which never does.
    this.lit = null;
    this.tips = [];
    // The perks' info buttons' tooltips (#717, setPerks).
    this.perkTips = [];
  }

  // The badges' tooltips and the perks' (#717).
  allTips() {
    return [...this.tips, ...this.perkTips.map((perk) => perk.tip)];
  }

  // Shuts every open badge or perk tooltip at once (#569).
  shutTips() {
    for (const tip of this.allTips()) shutTip(tip);
  }

  // A tap on a badge explains it; the next tap, a tap elsewhere or
  // Escape closes it, and so does any scroll, the pane folding or the
  // pane settling (#569, Cart's wire and apply).
  wire() {
    const tips = all(this.root, "[data-tip]").map((badge) => new Tooltip(
      badge, { title: badge.dataset.tip, trigger: "click", placement: "top" }
    ));

    this.tips = tips;
    this.root.addEventListener("show.bs.tooltip", (e) => {
      for (const tip of this.allTips()) {
        if (tip._element !== e.target) tip.hide();
      }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("[data-tip]")) {
        for (const tip of tips) tip.hide();
      }
    });
    // Escape with the focus outside the pane (the pane's own keydown
    // takes it inside).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.root.contains(e.target)) {
        this.shutTips();
      }
    });
  }

  // A page built before a money change (data/delivery.json,
  // money.changes) still carries the old tiers and minimum: bring them
  // to the day's. `money` is moneyOn()'s for the day.
  setMoney(money) {
    const tiers = tierKeys(money);

    for (const badge of all(this.root, "[data-badge^='tier-']")) {
      if (!tiers.includes(badge.dataset.badge)) badge.closest("li").remove();
    }

    const delivery = qs(this.root, "[data-badge='delivery']");

    if (delivery) {
      delivery.dataset.tip = deliveryTip(delivery.dataset.tip, money);
    }
  }

  // A badge that just turned on sends its chicks; the first render (a
  // restored draft) only sets the baseline. They leave the badge
  // itself; with the pane folded or the badge out of sight, the total.
  draw(s) {
    const root = this.root;
    const lit = {};

    for (const badge of s.badges) {
      const el = qs(root, `[data-badge="${badge.key}"]`);

      lit[badge.key] = badge.on;
      if (!el) continue;
      el.dataset.on = String(badge.on);
      if (badge.on && this.lit && !this.lit[badge.key]) {
        celebrate(seenIn(root, el) ? el : qs(root, "[data-total='total']"));
      }
    }
    this.lit = lit;
  }

  // The signed-in customer's perks (#514): what the totals already
  // apply, said so the customer knows why, as pricing labels with no
  // end dates (#717, perk-label.js). Free delivery shows on its badge,
  // with an info button when no bundle's tooltip explains it, and a
  // buying group's `member` (/api/me's) has its line (#717, revised).
  // The info buttons' tooltips go with the badges' (shutTips).
  setPerks(perks, { member = null } = {}) {
    const note = qs(this.root, "[data-cart-perks]");

    if (!note) return;
    for (const tip of this.perkTips) tip.stop();
    this.perkTips = drawPerks(note, perks, { freeBadge: true, member });
    note.hidden = !note.childElementCount;

    const badge = qs(this.root, "[data-badge='free-delivery']");
    const info = badge && drawBadgeInfo(badge.closest("li"), perks);

    if (info) this.perkTips.push(info);
  }
}
