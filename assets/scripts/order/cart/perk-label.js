// A customer's perks as pricing labels (#717), drawn into the cart
// note and the account page's "Your pricing" row from the
// #perk-label-template (partials/order/perk-label.html), so the
// classes survive PurgeCSS. A bundled perk is one line, its label and
// an info button whose tooltip lists the parts; the standalone perks
// share a line, between the discount badges' dots.
//
// The tooltip behaves as the badges' do (#569, #644): a tap or a
// click opens it and the next one shuts it, as do a tap elsewhere,
// Escape and any scroll, at once and with no fade (tip.js). It also
// opens while a mouse rests on the button or the focus is on it.

import Tooltip from "bootstrap/js/dist/tooltip.js";
import { perkLines } from "../lib/perks.mjs";
import { setKept } from "../../utils/keep-together.mjs";
import { shutTip } from "./tip.js";

const part = (template, selector) => template.content
  .querySelector(selector).cloneNode(true);

// The tooltip of `button`, listing `parts`. -> { tip, stop }: the
// Bootstrap tooltip, and stop() to take it and its listeners away.
const infoTip = (button, parts, template) => {
  const list = () => {
    const ul = part(template, "[data-perk-parts]");

    ul.replaceChildren(...parts.map((text) => {
      const li = document.createElement("li");

      li.textContent = text;

      return li;
    }));

    return ul;
  };
  const tip = new Tooltip(button, {
    title: list, html: true, trigger: "manual", placement: "top",
    customClass: "tooltip-perk",
  });
  const away = new AbortController();
  const on = { signal: away.signal };
  const passive = { signal: away.signal, passive: true };
  // Opened by a tap or a click, it stays until the next one; opened by
  // a resting mouse or the focus, it goes when they do.
  let pinned = false;
  let over = false;
  const shown = () => Boolean(tip.tip && tip.tip.classList.contains("show"));
  const open = () => {
    if (!shown()) tip.show();
  };
  const shut = () => shutTip(tip);
  const lapse = () => {
    if (!pinned && !over && document.activeElement !== button) shut();
  };

  button.addEventListener("hide.bs.tooltip", () => { pinned = false; }, on);
  button.addEventListener("click", () => {
    if (shown() && pinned) {
      shut();

      return;
    }
    open();
    pinned = true;
  }, on);
  button.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    over = true;
    open();
  }, passive);
  button.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    over = false;
    lapse();
  }, passive);
  button.addEventListener("focus", open, on);
  button.addEventListener("blur", lapse, on);
  document.addEventListener("click", (e) => {
    if (!button.contains(e.target)) shut();
  }, on);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") shut();
  }, on);
  // Any scroll, of the page or of a pane inside it, before it moves.
  document.addEventListener("scroll", shut, { ...passive, capture: true });

  return {
    tip,
    stop: () => {
      away.abort();
      shut();
      tip.dispose();
    },
  };
};

// Draws `perks` into `place`, with their end dates when `dates` is
// set. -> the info buttons' tooltips ({ tip, stop }, as infoTip). The
// caller stops the last ones before drawing again.
export const drawPerks = (place, perks, { dates = false } = {}) => {
  const template = document.getElementById("perk-label-template");
  const tips = [];

  place.replaceChildren(...perkLines(perks, { dates }).map((line) => {
    if (line.labels) {
      const ul = part(template, "[data-perk-labels]");
      const item = ul.querySelector("[data-perk-label]");

      ul.replaceChildren(...line.labels.map((text) => {
        const li = item.cloneNode();

        setKept(li, text);

        return li;
      }));

      return ul;
    }

    const row = part(template, "[data-perk-bundle]");
    const button = row.querySelector("button");

    setKept(row.querySelector("[data-perk-name]"), line.text);
    // Draft wording, for comms.
    button.setAttribute("aria-label", `What ${line.name} includes`);
    tips.push(infoTip(button, line.parts, template));

    return row;
  }));

  return tips;
};
