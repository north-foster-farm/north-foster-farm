// The pickup picker's state switcher (#573), on staging and deploy
// previews only: partials/staging/picker-states.html builds it when
// Netlify's CONTEXT is "branch-deploy" or "deploy-preview", on the
// order and account pages, and never in a production build
// (bin/check-staging.mjs holds production to that).
//
// A classic script at the end of <body>, so it runs before the page's
// own deferred modules: it can seed the order draft a state needs and
// answer the page's requests before the page makes them. A state is
// chosen with ?picker=<key> (the panel's links) and kept for the tab
// in sessionStorage until ?picker=off. Each state's lists come from
// picker-states.mjs; the page's own code does the rest, so what James
// sees is the real picker in its real homes.
//
// While a state is on, the order page's lists are built from the
// page's own series and places at the browser's time, so the staging
// clock does not move them; the account page's come from /api/dates.

import { Lapsed } from "../order/lapsed.js";
import { scheduledChoices } from "../order/lib/scheduled.mjs";
import {
  SAMPLE_ORDER, STATES, answerAt, dropCodeOf, isState, openList,
  stateParts,
} from "./picker-states.mjs";

const KEY = "nff-picker-state";
const DRAFT = "nff-order-draft";
// The states only the order page has: they need its draft, its ?edit=
// or its dialog.
const ORDER_ONLY = new Set(["closing", "moved", "edit", "lapsed"]);

const session = {
  get: () => {
    try {
      return window.sessionStorage.getItem(KEY) || "";
    } catch {
      return "";
    }
  },
  set: (value) => {
    try {
      if (value) window.sessionStorage.setItem(KEY, value);
      else window.sessionStorage.removeItem(KEY);
    } catch {
      // Storage blocked: the state lasts for this page only.
    }
  },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const pageData = () => {
  for (const [page, id] of [["order", "order-data"],
    ["account", "account-data"]]) {
    const el = document.getElementById(id);

    if (el) return { page, data: JSON.parse(el.textContent) };
  }

  return { page: "", data: {} };
};

const firstSku = (catalog) => ((catalog && catalog.groups) || [])
  .flatMap((g) => g.items || []).map((i) => i.sku)[0] || "";

// ?picker=<key> chooses a state, ?picker=off ends it; the parameter
// leaves the address so the page's own links and reloads stay clean.
const chosenState = () => {
  const url = new URL(window.location.href);
  const asked = url.searchParams.get("picker");

  if (asked !== null) {
    session.set(isState(asked) ? asked : "");
    url.searchParams.delete("picker");
    window.history.replaceState(window.history.state, "", url);
  }

  return session.get();
};

// The draft a state restores, keeping the cart and the contact the
// draft already holds.
const seedDraft = (fulfilment) => {
  try {
    const record = JSON.parse(window.localStorage.getItem(DRAFT) || "{}");
    const payload = record.payload || {};

    window.localStorage.setItem(DRAFT, JSON.stringify({
      ...record,
      payload: { lines: [], customer: {}, ...payload, fulfilment },
      savedAt: Date.now(),
    }));
  } catch {
    // Storage blocked: the state shows without its draft.
  }
};

const pathOf = (input) => new URL(
  typeof input === "string" ? input : input.url, window.location.href,
).pathname;

const methodOf = (input, init) => String(
  (init && init.method) || (typeof input === "string" ? "GET"
    : input.method) || "GET",
).toUpperCase();

// Answers the page's requests for the state: /api/dates always, and on
// the order page the sample order's for ?edit=.
const intercept = ({ page, data, state, parts: built }) => {
  const real = window.fetch.bind(window);
  const timeZone = (data.terms || {}).timeZone || "America/New_York";
  let parts = built;
  let answered = 0;

  const dates = async (input, init) => {
    const first = answered === 0;

    answered += 1;

    let body = { onfarm: [], delivery: [] };

    try {
      const res = await real(input, init);

      if (res.ok) body = await res.json();
    } catch {
      // The real lists failed: the state still answers its own.
    }
    // The account page has no draft to seed, so its state is built
    // from the real list, at the server's time.
    if (!parts) {
      parts = stateParts(state, {
        now: new Date(body.now || Date.now()), timeZone,
        list: body.scheduled || [], dropCode: dropCodeOf(data.series),
      });
    }
    if (parts.scheduled === null) {
      return json({ error: "A failed load (picker state)." }, 503);
    }
    if (first && parts.delay) await sleep(parts.delay);

    const now = page === "order" ? Date.now()
      : Date.parse(body.now || "") || Date.now();

    return json({
      ...body,
      now: new Date(now).toISOString(),
      scheduled: answerAt(parts.scheduled, now),
    });
  };

  window.fetch = (input, init) => {
    const path = pathOf(input);
    const method = methodOf(input, init);

    if (path === "/api/dates" && method === "GET") return dates(input, init);
    if (parts && parts.order) {
      if (path === "/api/account/orders" && method === "GET") {
        return Promise.resolve(json({ ok: true, orders: [parts.order] }));
      }
      if (path.startsWith(`/api/account/orders/${SAMPLE_ORDER}/`)) {
        return Promise.resolve(json({
          ok: false, message: "The picker states' sample order can't be " +
            "saved.",
        }, 400));
      }
    }

    return real(input, init);
  };
};

// The lapsed dialog for the lapsed state, as a 409 at payment opens
// it: the real dialog's markup and code (order/lapsed.js) on a copy,
// so the page's own dialog and its listeners are left alone. "Use this
// pickup" chooses it on the form, as the page's would.
const openLapsed = ({ data, parts }) => {
  const source = document.getElementById("order-lapsed");

  if (!source || !parts.lapse) return;

  let dialog = document.getElementById("picker-states-lapsed");

  if (!dialog) {
    dialog = source.cloneNode(true);
    for (const el of dialog.querySelectorAll("[id]")) {
      el.id = `picker-states-${el.id}`;
    }
    dialog.id = "picker-states-lapsed";
    dialog.setAttribute("aria-labelledby",
      "picker-states-order-lapsed-title");
    dialog.setAttribute("aria-describedby",
      "picker-states-order-lapsed-lead");
    source.after(dialog);
  }

  const locations = data.locations || [];
  const lapsed = dialog.lapsed || new Lapsed(dialog, {
    onUse: ({ date }) => {
      const radio = document.querySelector(
        `#scheduled-pickups input[value="${CSS.escape(date)}"]`,
      );

      if (radio) radio.click();
    },
    onOther: () => {},
    locate: (entry) => locations.find((l) => l.code === entry.location)
      || null,
  });

  dialog.lapsed = lapsed;

  const open = answerAt(parts.scheduled, Date.now())
    .filter((d) => d.occurrence !== parts.lapse.occurrence);

  lapsed.open("scheduled", scheduledChoices(open), null, new Date(), {
    closed: scheduledChoices([parts.lapse])[0],
  });
};

// Opens the lapsed dialog once the form's picker has its pickups.
const whenListed = (then) => {
  const ready = () => document.querySelector("#scheduled-pickups input");

  if (ready()) {
    then();

    return;
  }

  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    then();
  });

  watch.observe(document.body, { childList: true, subtree: true });
};

const hrefFor = (key, page) => {
  if (key === "edit") return `/order/?edit=${SAMPLE_ORDER}&picker=edit`;
  if (page !== "order" && ORDER_ONLY.has(key)) return `/order/?picker=${key}`;

  return `${window.location.pathname}?picker=${key}${window.location.hash}`;
};

const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);

  node.append(...kids);

  return node;
};

// The panel: the states as links, the one on marked, and a way off.
const drawPanel = ({ page, state, reopen }) => {
  const now = STATES.find((s) => s.key === state);
  const items = STATES.map((s) => {
    const link = el("a", { href: hrefFor(s.key, page), textContent: s.name });

    if (s.key === state) link.setAttribute("aria-current", "true");

    return el("li", {}, [link]);
  });
  const off = el("a", {
    href: `${window.location.pathname}?picker=off${window.location.hash}`,
    textContent: "Live data",
  });
  const panel = el("details", { className: "picker-states" }, [
    el("summary", { textContent: `Picker: ${now ? now.name : "live data"}` }),
    el("p", { textContent: "Staging and previews only. Each state " +
      "reloads the page with made-up lists." }),
    el("ul", {}, [...items, el("li", {}, [off])]),
  ]);

  panel.dataset.pickerStates = "";
  if (reopen) {
    const again = el("button", {
      type: "button", textContent: "Open the dialog again",
    });

    again.addEventListener("click", reopen);
    panel.append(again);
  }
  document.body.append(panel);
};

const start = () => {
  const state = chosenState();
  const { page, data } = pageData();

  if (!page) return;

  let reopen = null;

  if (isState(state)) {
    const timeZone = (data.terms || {}).timeZone || "America/New_York";
    // The order page's lists are built now, so a draft can name one of
    // its pickups before the page reads the draft.
    const parts = page === "order" ? stateParts(state, {
      now: new Date(), timeZone, dropCode: dropCodeOf(data.series),
      sku: firstSku(data.catalog),
      list: openList({ now: new Date(), timeZone,
        locations: data.locations, series: data.series }),
    }) : null;

    if (parts && parts.draft) seedDraft(parts.draft);
    intercept({ page, data, state, parts });
    if (parts && parts.lapse) {
      reopen = () => openLapsed({ data, parts });
      whenListed(reopen);
    }
  }
  drawPanel({ page, state, reopen });
};

start();
