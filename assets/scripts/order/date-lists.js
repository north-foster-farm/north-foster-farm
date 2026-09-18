// The date selects and the cutoff countdown. Dates come from the
// server on load, and the clock is anchored to the server's, so a
// visitor's wrong clock cannot offer a closed date.

const RETRY = [2000, 5000, 15000, 30000];

const pad = (n) => String(n).padStart(2, "0");

export class DateLists {
  constructor(form, onChange) {
    this.form = form;
    this.onChange = onChange;
    this.offset = 0;
    this.lists = null;
    this.attempt = 0;
    this.timer = null;
    this.countdown = form.querySelector("[data-countdown]");
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

  note(text) {
    if (this.countdown) this.countdown.textContent = text;
  }

  tick() {
    clearTimeout(this.timer);

    if (!this.countdown || !this.lists) return;

    const next = this.lists.delivery[0];

    if (!next) {
      this.note("Ordering for delivery is closed right now.");

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

    const total = Math.floor(remaining / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const left = days > 0
      ? `${days}d ${hours}h ${pad(minutes)}m`
      : `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;

    this.note(`Ordering for ${next.label} closes in ${left}.`);
    this.timer = setTimeout(() => this.tick(), 1000);
  }
}
