// The pickup-days layout (#703), drawn the same wherever a customer
// chooses a scheduled pickup: the order page's Pickup days card, the
// lapsed dialog and the account's Change pickup. The markup is
// partials/order/pickup-days.html; the parts come from
// lib/scheduled.mjs (pickupDays).

import { pickupDays, roundCard } from "./lib/scheduled.mjs";

// How long Copy says "Copied" before it reads Copy again.
export const COPIED_MS = 2000;

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
  // The word only: the icon before it stays.
  const word = button.querySelector(".order-pickup-copy-text");

  word.textContent = "Copied";
  status.textContent = "Copied";
  clearTimeout(button.copiedTimer);
  button.copiedTimer = setTimeout(() => {
    word.textContent = "Copy";
    status.textContent = "";
  }, COPIED_MS);
};

const card = (pickup, { name, id, pick, template = "tpl-pickup" }) => {
  const node = document.getElementById(template).content
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
    button.addEventListener("click",
      () => copy(button, status, pickup.copy, address));
  } else {
    button.remove();
    status.remove();
  }
  if (pickup.map) map.href = pickup.map;
  else map.remove();
  if (!pickup.copy && !pickup.map) q(".order-pickup-actions").remove();

  return node;
};

// Draws a buying group's rounds (#749) into `box`, one card each and
// no heading over them, since each card says its own date: the date,
// the place, the hours and the address, with Copy (lib/scheduled.mjs
// roundCard, partials/order/pickup-days.html's tpl-round). The rest as
// for drawPickupDays.
export const drawRounds = (box, choices, {
  place = () => null, name, id, pick = "",
}) => {
  const list = document.createElement("div");

  box.textContent = "";
  list.className = "order-pickup-list";
  for (const entry of choices) {
    list.appendChild(card(roundCard(entry, place(entry.location)), {
      name, id, pick, template: "tpl-round",
    }));
  }
  box.appendChild(list);
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
