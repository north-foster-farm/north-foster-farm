// The pickup picker's state switcher (#574): on a branch deploy
// (staging) or a deploy preview only, never in production
// (partials/staging/picker-states.html builds it only there, and
// bin/check-staging.mjs holds a production build to that). It answers
// the page's own requests for the dates, and for a state that needs
// one, the signed-in customer and their order, from picker-states/
// states.mjs, so James can put the picker in each hard state at any
// width. A state lasts the tab's session until Off.
//
// It runs in the head, before the page's scripts, so it can wrap
// fetch before they ask for anything.

import {
  CUSTOMER, KEY, ORDER_ID, STATES, build, open, stateOf,
} from "./states.mjs";

const SINCE = `${KEY}-since`;
// The order page's draft (order/draft.js) and the session's cache of
// /api/me (session/session.js).
const DRAFT = "nff-order-draft";
const ME = "nff-me";

const store = {
  get: (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {
      // A tool only.
    }
  },
};

const facts = () => {
  const node = document.getElementById("picker-states-data");

  return node ? JSON.parse(node.textContent) : null;
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

// What the state answers: built from the moment it was chosen, so the
// closing pickup's cutoff stays where it was set.
const planFor = (key) => {
  const data = facts();

  if (!data) return null;

  return build(key, {
    series: data.series, locations: data.locations, sku: data.sku,
    timeZone: data.timeZone,
    now: new Date(Number(store.get(SINCE)) || Date.now()),
  });
};

const wrap = (key) => {
  const real = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url,
      location.href);
    const plan = url.origin === location.origin && planFor(key);

    if (!plan) return real(input, init);
    if (url.pathname === "/api/dates") {
      if (plan.loading) return new Promise(() => {});
      if (plan.failed) return json({ ok: false }, 503);

      // The rest of the answer is the deploy's own: the on-farm and
      // delivery lists and the server's clock.
      const res = await real(input, init).catch(() => null);
      const data = res && res.ok ? await res.json()
        : { now: new Date().toISOString(), onfarm: [], delivery: [] };

      return json({
        ...data, scheduled: open(plan.scheduled, new Date(data.now)),
      });
    }
    if (plan.order && url.pathname === "/api/me") {
      return json({ signedIn: true, customer: CUSTOMER });
    }
    if (plan.order && url.pathname === "/api/account/orders") {
      return json({ orders: [plan.order] });
    }

    return real(input, init);
  };
};

// Choosing a state: the draft it needs (or none left behind), then
// the page it shows on.
const choose = (key) => {
  const state = stateOf(key);

  store.set(KEY, state ? key : null);
  store.set(SINCE, state ? String(Date.now()) : null);
  store.set(ME, null);

  const plan = state && planFor(key);

  try {
    if (plan && plan.draft) {
      localStorage.setItem(DRAFT, JSON.stringify(plan.draft));
    } else if (state) {
      localStorage.removeItem(DRAFT);
    }
  } catch {
    // Storage blocked: the state shows without its draft.
  }

  const page = state && state.page;

  location.assign(page === "account" ? "/account/#orders"
    : page === "edit" ? `/order/?edit=${ORDER_ID}` : "/order/");
};

// The lapsed state presses Pay once the picker has its pickup, as the
// customer would; the page's own check finds it lapsed.
const pressPay = () => {
  let tries = 0;
  const wait = setInterval(() => {
    const ready = document.querySelector("#scheduled-pickups input:checked");
    const pay = document.getElementById("order-submit");

    tries += 1;
    if (ready && pay && !pay.disabled) {
      clearInterval(wait);
      pay.click();
    } else if (tries > 60) {
      clearInterval(wait);
    }
  }, 500);
};

const wire = (key) => {
  const box = document.querySelector("[data-picker-states]");

  if (!box) return;

  const select = box.querySelector("select");
  const on = box.querySelector("[data-picker-states-now]");

  for (const state of STATES) select.add(new Option(state.label, state.key));
  select.value = key || "";
  on.textContent = key ? `Showing: ${stateOf(key).label}` : "";
  on.hidden = !key;
  box.querySelector("[data-picker-states-show]").addEventListener("click",
    () => choose(select.value));
  if (key === "lapsed" && location.pathname === "/order/") pressPay();
};

const key = stateOf(store.get(KEY)) ? store.get(KEY) : "";

if (key) wrap(key);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => wire(key));
} else {
  wire(key);
}
