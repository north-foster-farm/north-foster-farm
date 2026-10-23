// The date selects and the cutoff countdown. Dates come from the
// server on load, and the clock is anchored to the server's, so a
// visitor's wrong clock cannot offer a closed date.

import {
  fallbackChoice, pickupParts, scheduledChoices,
} from "./lib/scheduled.mjs";
import { clear, whileLoading } from "../utils/skeleton.js";

const RETRY = [2000, 5000, 15000, 30000];
const HOUR = 3_600_000;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "2 days, 5 hours, and 12 minutes"; the leading zero units are left
// off, so under an hour it is just the minutes.
export const countdown = (days, hours, minutes) => {
  const parts = [];

  if (days) parts.push(plural(days, "day"));
  if (days || hours) parts.push(plural(hours, "hour"));
  parts.push(plural(minutes, "minute"));

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;

  return `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
};

export class DateLists {
  constructor(form, onChange) {
    this.form = form;
    this.onChange = onChange;
    this.offset = 0;
    this.lists = null;
    this.attempt = 0;
    this.timer = null;
    this.chip = form.querySelector("[data-countdown]");
    this.text = form.querySelector("[data-countdown-text]");
    this.regions = form.querySelectorAll("[data-dates-region]");
    this.again = null;
    // Every occurrence /api/dates has listed, kept after it has gone, so
    // a confirmation can still name where an order is to be picked up.
    this.occurrences = new Map();
  }

  now() {
    return new Date(Date.now() + this.offset);
  }

  // The lists once, now; false if they couldn't be had. Before a
  // payment goes out, so a pickup time the farm has since dropped is
  // caught before a wallet opens (W11d).
  async refresh() {
    try {
      const res = await fetch("/api/dates", { cache: "no-store" });

      if (!res.ok) return false;
      this.apply(await res.json());

      return true;
    } catch {
      return false;
    }
  }

  // The farm's pickup windows as the validator takes them, rebuilt from
  // the lists: the page never holds the schedule itself. Each scheduled
  // pickup on offer comes back as the `pickup` line that opened it.
  schedule() {
    const windows = ((this.lists && this.lists.onfarm) || []).flatMap((d) =>
      (d.windows || []).map((w) => ({ date: d.date, ...w })));
    const lines = ((this.lists && this.lists.scheduled) || []).map((d) => ({
      date: d.date, code: d.series, action: "pickup",
    }));

    return Object.assign(windows, { lines });
  }

  // The first load, and a Try again: the date fields show their
  // skeletons while it runs (#271). A failure says so under the
  // field, and the lists are asked for again in the background.
  async load() {
    const data = await whileLoading(this.regions, () => this.fetchLists(), {
      render: (lists) => this.apply(lists),
      retry: () => this.load(),
    });

    if (data) {
      this.attempt = 0;
    } else {
      this.retryLater();
    }
  }

  // -> the lists, or null.
  async fetchLists() {
    const res = await fetch("/api/dates", { cache: "no-store" });

    return res.ok ? res.json() : null;
  }

  retryLater() {
    const delay = RETRY[Math.min(this.attempt++, RETRY.length - 1)];

    this.note("We couldn't load the dates. Retrying…");
    clearTimeout(this.again);
    this.again = setTimeout(async () => {
      if (await this.refresh()) {
        this.attempt = 0;
        clear(this.regions);
      } else {
        this.retryLater();
      }
    }, delay);
  }

  apply(data) {
    this.offset = Date.parse(data.now) - Date.now();
    this.lists = { ...data, scheduled: this.scheduled(data.scheduled) };

    for (const select of this.form.querySelectorAll("[data-dates]")) {
      this.fill(select, this.lists[select.dataset.dates] || []);
    }

    this.tick();
    this.onChange();
  }

  // The scheduled pickup entries as choices (lib/scheduled.mjs), each
  // remembered by its occurrence id.
  scheduled(list) {
    const choices = scheduledChoices(list);

    for (const c of choices) this.occurrences.set(c.occurrence, c);

    return choices;
  }

  // An occurrence's place and window, from any entry it has had.
  occurrence(id) {
    return this.occurrences.get(id) || null;
  }

  // A date to choose once the lists come: a restored draft's, or the
  // paid order's being changed. Set on the select before its options
  // exist, the browser would drop it and the first date would win
  // (#284). For `scheduled` the "date" is the option's value, the
  // occurrence id.
  want(method, date, series = "") {
    const select = this.form.querySelector(`[data-dates="${method}"]`);

    if (!select || !date) return;
    select.dataset.want = date;
    if (series) select.dataset.series = series;
    if (this.lists) this.fill(select, this.lists[method] || []);
  }

  // The occurrence id of the pickup chosen, "" while none is.
  scheduledValue() {
    const box = this.form.querySelector("[data-dates='scheduled']");
    const on = box && box.querySelector("input:checked");

    return on ? on.value : "";
  }

  // Chooses a pickup in the list, if it is there.
  choose(value) {
    const box = this.form.querySelector("[data-dates='scheduled']");
    const radio = box && Array.from(box.querySelectorAll("input"))
      .find((input) => input.value === value);

    if (radio) radio.checked = true;

    return Boolean(radio);
  }

  // The scheduled pickups as a vertical list of radios, one line each,
  // from the template (#tpl-pickup). Nothing is chosen but what the
  // customer chose, or a draft or link named; a draft's closed
  // occurrence of the old drop site falls to that series' next.
  fillPickups(box, list) {
    const current = box.dataset.want || this.scheduledValue();
    const series = box.dataset.series || "";

    box.textContent = "";
    delete box.dataset.want;
    delete box.dataset.series;

    if (list.length === 0) {
      const none = document.createElement("p");

      none.className = "order-windows-none";
      none.textContent = "No scheduled pickups are open right now";
      box.appendChild(none);

      return;
    }

    const kept = list.some((d) => d.value === current);
    const pick = kept ? current
      : series && (fallbackChoice(list, series) || {}).value;

    for (const entry of list) {
      const node = document.getElementById("tpl-pickup").content
        .cloneNode(true);
      const input = node.querySelector("input");
      const label = node.querySelector("label");
      const parts = pickupParts(entry);

      input.id = `scheduled-${entry.value.toLowerCase()}`;
      input.value = entry.value;
      input.checked = entry.value === pick;
      label.htmlFor = input.id;
      label.querySelector(".order-pickup-date").textContent = parts.date;
      label.querySelector(".order-pickup-time").textContent = parts.time;
      label.querySelector(".order-pickup-place").textContent = parts.place;
      box.appendChild(node);
    }
  }

  fill(select, list) {
    if (select.dataset.dates === "scheduled") {
      this.fillPickups(select, list);

      return;
    }

    const current = select.dataset.want || select.value;

    select.textContent = "";

    if (list.length === 0) {
      const option = document.createElement("option");

      option.value = "";
      option.textContent = "No dates available right now";
      select.appendChild(option);
      select.disabled = true;

      return;
    }

    for (const entry of list) {
      const option = document.createElement("option");

      option.value = entry.date;
      option.textContent = entry.label;
      select.appendChild(option);
    }

    select.disabled = false;
    select.value = list.some((d) => d.date === current)
      ? current : list[0].date;
    delete select.dataset.want;
  }

  // The 409 answer carries a fresh list for the way that went stale.
  replace(method, list) {
    const select = this.form.querySelector(`[data-dates="${method}"]`);
    const fresh = method === "scheduled" ? this.scheduled(list) : list;

    if (this.lists) this.lists[method] = fresh;
    if (select) this.fill(select, fresh);
    if (method === "delivery" && this.lists) this.tick();
    this.onChange();
  }

  note(text, urgency = "") {
    if (!this.chip) return;

    this.text.textContent = text;
    if (urgency) {
      this.chip.dataset.urgency = urgency;
    } else {
      delete this.chip.dataset.urgency;
    }
  }

  tick() {
    clearTimeout(this.timer);

    if (!this.chip || !this.lists) return;

    const next = this.lists.delivery[0];

    if (!next) {
      this.note("Delivery ordering is closed right now.");

      return;
    }

    const remaining = Date.parse(next.cutoff) - this.now().getTime();

    if (remaining < 0) {
      // The cutoff passed while the page was open: refresh the lists
      // so the closed date leaves the select without a reload.
      this.note("That cutoff just passed. Updating dates…");
      this.refresh().then((ok) => ok || this.retryLater());

      return;
    }

    const minutes = Math.floor(remaining / 60_000);
    const hours = Math.floor(remaining / HOUR);
    const days = Math.floor(hours / 24);
    let urgency = "";
    let every = 60_000;

    if (remaining < HOUR) {
      urgency = "last";
      every = 10_000;
    } else if (remaining < 6 * HOUR) {
      urgency = "soon";
    }

    this.note(`Order in the next ${countdown(days, hours % 24,
      Math.max(minutes % 60, days || hours ? 0 : 1))} to get your order on ` +
      "our next delivery day.", urgency);
    this.timer = setTimeout(() => this.tick(), every);
  }
}
