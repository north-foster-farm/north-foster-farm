// A customer's perks as pricing labels (#717), drawn into the cart
// note and the account page's "Your pricing" row from the
// #perk-label-template (partials/order/perk-label.html), so the
// classes survive PurgeCSS. A bundled perk is one line, its label and
// an info button whose tooltip lists the parts; the standalone perks
// share a line, between the discount badges' dots. James's revision
// adds the same info button to a buying group's member line, beside
// the cart's free delivery badge, and to the delivery terms where the
// site states the fee and the minimum together.
//
// The tooltip behaves as the badges' do (#569, #644): a tap or a
// click opens it and the next one shuts it, as do a tap elsewhere,
// Escape and any scroll, at once and with no fade (tip.js). It also
// opens while a mouse rests on the button or the focus is on it.

import Tooltip from "bootstrap/js/dist/tooltip.js";
import { deliveryTerms, freeBadgeTip, perkLines } from "../lib/perks.mjs";
import { setKept } from "../../utils/keep-together.mjs";
import { shutTip } from "./tip.js";

const part = (template, selector) => template.content
  .querySelector(selector).cloneNode(true);

const template = () => document.getElementById("perk-label-template");

// Its children each take a line, or a bullet in a list.
const filled = (box, texts, tag) => {
  box.replaceChildren(...texts.map((text) => {
    const child = document.createElement(tag);

    child.textContent = text;

    return child;
  }));

  return box;
};

// The tooltip of `button`: a list of `parts`, as a bundle's, or else
// its `lines`, each on its own. -> { tip, stop }: the Bootstrap
// tooltip, and stop() to take it and its listeners away.
const infoTip = (button, { parts, lines }, tpl) => {
  const title = () => (parts
    ? filled(part(tpl, "[data-perk-parts]"), parts, "li")
    : filled(part(tpl, "[data-perk-lines]"), lines, "span"));
  const tip = new Tooltip(button, {
    title, html: true, trigger: "manual", placement: "top",
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
  // Where the button stood on screen when the tooltip opened. A scroll
  // event comes a frame after its scroll, so one that brought the
  // button into view just before the tap lands after the tooltip
  // opens, and the page may hold the button still through a scroll
  // (scroll anchoring, as content above it settles). Only a scroll
  // that moved the button shuts it.
  let stood = null;
  const at = () => {
    const r = button.getBoundingClientRect();

    return { x: r.left, y: r.top };
  };
  const open = () => {
    if (shown()) return;
    stood = at();
    tip.show();
  };
  const scrolled = () => {
    const now = at();

    if (!stood || Math.abs(now.x - stood.x) > 1
      || Math.abs(now.y - stood.y) > 1) shut();
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
  document.addEventListener("scroll", scrolled, {
    ...passive, capture: true,
  });

  return {
    tip,
    stop: () => {
      away.abort();
      shut();
      tip.dispose();
    },
  };
};

// The info button, named `name`, its tooltip saying `content` (as
// infoTip). -> { button, tip, stop }.
const infoButton = (tpl, name, content) => {
  const button = part(tpl, "[data-perk-bundle] button");

  button.setAttribute("aria-label", name);

  return { button, ...infoTip(button, content, tpl) };
};

// A label and its info button, on a line of its own.
const labelled = (tpl, text, name, content, tips) => {
  const row = part(tpl, "[data-perk-bundle]");
  const info = infoButton(tpl, name, content);

  setKept(row.querySelector("[data-perk-name]"), text);
  row.querySelector("button").replaceWith(info.button);
  tips.push(info);

  return row;
};

// "Friends and family pricing" in a sentence, as the info button's
// name has it (approved in sentence case, James's revision of #717).
const lower = (name) => name.charAt(0).toLowerCase() + name.slice(1);

// A buying group's member line (#717, "Village Family Fitness
// member"): the group's `perk` in data/groups.json, from the
// template, for /api/me's `member`. -> { line, tip }, or null.
const memberPerk = (tpl, member) => {
  if (!member || !member.key) return null;
  try {
    return JSON.parse(tpl.dataset.members || "{}")[member.key] || null;
  } catch {
    return null;
  }
};

// Draws `perks` into `place`, with their end dates when `dates` is
// set and without free delivery when `freeBadge` is (the cart, whose
// badge shows it). A buying group's `member` (/api/me's) leads with
// the group's line, when it has one. -> the info buttons' tooltips
// ({ tip, stop }, as infoTip). The caller stops the last ones before
// drawing again.
export const drawPerks = (place, perks, {
  dates = false, freeBadge = false, member = null,
} = {}) => {
  const tpl = template();
  const tips = [];
  const group = memberPerk(tpl, member);
  const lines = perkLines(perks, { dates, freeBadge }).map((line) => {
    if (line.labels) {
      const ul = part(tpl, "[data-perk-labels]");
      const item = ul.querySelector("[data-perk-label]");

      ul.replaceChildren(...line.labels.map((text) => {
        const li = item.cloneNode();

        setKept(li, text);

        return li;
      }));

      return ul;
    }

    // Draft wording, for comms; the sentence case is approved.
    return labelled(tpl, line.text, `What ${lower(line.name)} includes`,
      { parts: line.parts }, tips);
  });

  if (group) {
    // The name is a draft, for comms: "What Village Family Fitness
    // membership includes", from a line that ends "member".
    lines.unshift(labelled(tpl, group.line,
      `What ${group.line}ship includes`, { lines: [group.tip] }, tips));
  }
  place.replaceChildren(...lines);

  return tips;
};

// The info button beside the cart's free delivery badge (#717,
// revised): there when free delivery is the account's and no bundle's
// tooltip explains it, gone otherwise. `item` is the badge's list
// item. -> its tooltip ({ tip, stop }), or null.
export const drawBadgeInfo = (item, perks) => {
  for (const old of item.querySelectorAll("[data-perk-badge-info]")) {
    old.remove();
  }

  const text = freeBadgeTip(perks);

  if (!text) return null;

  // The name is a draft, for comms.
  const info = infoButton(template(), "About your free delivery",
    { lines: [text] });

  info.button.dataset.perkBadgeInfo = "";
  item.append(info.button);

  return info;
};

// What each place that states the fee and the minimum together first
// held, to put back for an account that changes neither.
const asBuilt = new WeakMap();

// Each place that states the delivery fee and the minimum together
// (`[data-delivery-terms]`, its amounts in `data-fee` and
// `data-minimum`; the words are in its last element when the value is
// "last") says the terms the account's `perks` give, with an info
// button whose tooltip gives the usual ones first (#717, "Delivery
// terms for perk customers"). An account that changes neither leaves
// the page as built. -> the tooltips, as drawPerks.
export const drawTerms = (perks, root = document) => {
  const tips = [];

  for (const marked of root.querySelectorAll("[data-delivery-terms]")) {
    const place = marked.dataset.deliveryTerms === "last"
      ? marked.lastElementChild : marked;

    if (!asBuilt.has(place)) asBuilt.set(place, [...place.childNodes]);

    const terms = deliveryTerms(perks, {
      fee: marked.dataset.fee, minimum: marked.dataset.minimum,
    });

    if (!terms) {
      place.replaceChildren(...asBuilt.get(place));
      continue;
    }

    // The name is a draft, for comms.
    const info = infoButton(template(), "About your delivery terms",
      { lines: terms.tip });
    const text = document.createElement("span");

    setKept(text, terms.text);
    place.replaceChildren(text, " ", info.button);
    tips.push(info);
  }

  return tips;
};
