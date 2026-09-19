// The date selects and the cutoff countdown. Dates come from the
// server on load, and the clock is anchored to the server's, so a
// visitor's wrong clock cannot offer a closed date.

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
  }

  now() {
    return new Date(Date.now() + this.offset);
  }

  async load() {
    try {
      const res = await fetch("/api/dates", { cache: "no-store" });

      if (!res.ok) throw new Error(String(res.status));

      this.apply(await res.json());
      this.attempt = 0;
    } catch {
      const delay = RETRY[Math.min(this.attempt++, RETRY.length - 1)];

      this.note("We couldn't load the available dates. Retrying…");
      setTimeout(() => this.load(), delay);
    }
  }

  apply(data) {
    this.offset = Date.parse(data.now) - Date.now();
    this.lists = data;

    for (const select of this.form.querySelectorAll("[data-dates]")) {
      this.fill(select, data[select.dataset.dates] || []);
    }

    this.tick();
    this.onChange();
  }

  fill(select, list) {
    const current = select.value;

    select.textContent = "";

    if (list.length === 0) {
      const option = document.createElement("option");

      option.value = "";
      option.textContent = "No dates available right now";
      select.appendChild(option);
      select.disabled = true;

      return;
    }

    for (const { date, label } of list) {
      const option = document.createElement("option");

      option.value = date;
      option.textContent = label;
      select.appendChild(option);
    }

    select.disabled = false;
    select.value = list.some((d) => d.date === current)
      ? current
      : list[0].date;
  }

  // The 409 answer carries a fresh list for the method that went stale.
  replace(method, list) {
    const select = this.form.querySelector(`[data-dates="${method}"]`);

    if (select) this.fill(select, list);
    if (method === "delivery" && this.lists) {
      this.lists.delivery = list;
      this.tick();
    }
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
      this.load();

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
