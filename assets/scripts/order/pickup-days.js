// The pickup-days layout (#703), drawn the same wherever a customer
// chooses a scheduled pickup: the order page's Pickup days card, the
// lapsed dialog and the account's Change pickup. The markup is
// partials/order/pickup-days.html; the parts come from
// lib/scheduled.mjs (pickupDays).

import { fit } from "../utils/busy-button.js";
import { pickupDays } from "./lib/scheduled.mjs";

// How long Copy says "Copied" before it reads Copy again.
export const COPIED_MS = 2000;

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Empties the ghost once its word has faded out, so the card never
// holds both words at rest.
const lay = (ghost) => {
  if (ghost.style.opacity !== "0") return;
  ghost.textContent = "";
  ghost.style.opacity = "";
};

// Changes Copy's word as the fitted busy button changes its face
// (#703): the width eases from the old word's to the new one's
// (busy-button.js fit), and the old word, left in the hidden ghost
// over the new, fades out while the new one fades in. The icon before
// them stays put. With reduced motion the word just changes.
const say = (button, text) => {
  const word = button.querySelector(".order-pickup-copy-text");
  const ghost = button.querySelector(".order-pickup-copy-ghost");
  const was = word.textContent;

  if (was === text) return;
  fit(button, () => { word.textContent = text; });
  if (calm()) return;

  ghost.textContent = was;
  ghost.style.left = `${word.offsetLeft}px`;
  ghost.style.top = `${word.offsetTop}px`;
  for (const [face, from] of [[ghost, "1"], [word, "0"]]) {
    face.style.transition = "none";
    face.style.opacity = from;
  }
  button.getBoundingClientRect();
  for (const face of [ghost, word]) face.style.transition = "";
  ghost.style.opacity = "0";
  word.style.opacity = "";
};

// Puts `text` on the clipboard and says so on the button for a
// moment, and in `status`, a visually hidden live region, so a screen
// reader announces it too (a focused button's new name often goes
// unread; WCAG 2.2, 4.1.3). Where the browser won't write the
// clipboard, the address is selected to copy by hand.
const copy = async (button, status, text, address) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.error("Copy failed", error);
    getSelection().selectAllChildren(address);

    return;
  }
  say(button, "Copied");
  status.textContent = "Copied";
  clearTimeout(button.copiedTimer);
  button.copiedTimer = setTimeout(() => {
    say(button, "Copy");
    status.textContent = "";
  }, COPIED_MS);
};

const card = (pickup, { name, id, pick }) => {
  const node = document.getElementById("tpl-pickup").content
    .cloneNode(true);
  const q = (s) => node.querySelector(s);
  const input = q("input");
  const label = q("label");
  const address = q(".order-pickup-address");
  const button = q(".order-pickup-copy");
  const status = q(".order-pickup-copied");
  const map = q(".order-pickup-map");

  input.id = `${id}-${pickup.value.toLowerCase()}`;
  input.name = name;
  input.value = pickup.value;
  input.checked = pickup.value === pick;
  label.htmlFor = input.id;
  q(".order-pickup-name").textContent = pickup.name;
  q(".order-pickup-time").textContent = pickup.time;
  q(".order-pickup-place").textContent = pickup.place;
  q(".order-pickup-street").textContent = pickup.street;
  q(".order-pickup-city").textContent = pickup.city;
  q(".order-pickup-place").hidden = !pickup.place;
  address.hidden = !pickup.copy;

  if (pickup.copy) {
    const ghost = q(".order-pickup-copy-ghost");

    button.addEventListener("click",
      () => copy(button, status, pickup.copy, address));
    // Not on transitioncancel: a change that interrupts the fade
    // cancels it, and the ghost then holds the next word.
    ghost.addEventListener("transitionend", (event) => {
      if (event.propertyName === "opacity") lay(ghost);
    });
  } else {
    button.remove();
    status.remove();
  }
  if (pickup.map) map.href = pickup.map;
  else map.remove();
  if (!pickup.copy && !pickup.map) q(".order-pickup-actions").remove();

  return node;
};

// Draws `choices` (lib/scheduled.mjs scheduledChoices) into `box`,
// grouped by date. `place` takes a location's code and gives the
// location; `name` is the radios' name and `id` the prefix of their
// ids; `pick` is the value chosen, if any.
export const drawPickupDays = (box, choices, {
  place = () => null, name, id, pick = "",
}) => {
  box.textContent = "";

  for (const day of pickupDays(choices, place)) {
    const node = document.getElementById("tpl-pickup-day").content
      .cloneNode(true);
    const group = node.querySelector(".order-pickup-day");
    const heading = node.querySelector(".order-pickup-day-heading");
    const list = node.querySelector(".order-pickup-list");

    heading.id = `${id}-day-${day.date}`;
    heading.textContent = day.heading;
    group.setAttribute("aria-labelledby", heading.id);
    for (const pickup of day.pickups) {
      list.appendChild(card(pickup, { name, id, pick }));
    }
    box.appendChild(node);
  }
};
