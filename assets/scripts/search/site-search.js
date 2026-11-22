// The site search (partials/search/field.html, #402): an ARIA 1.2
// combobox over /search.json. From 992 px the field sits in the header
// row and its results open in a panel under it; below that the
// header's magnifier opens a bar under the header, over a scrim, with
// Cancel. The index is fetched the first time search is opened or
// focused, never on load. Results come grouped (match.js); arrows move
// the active one while the focus stays in the field, and Enter or a
// click opens one. A product goes to its row on the order page; there
// is no Add. Esc, Cancel, X or a tap outside closes search.

import { index, search } from "./match.js";
import { listed, stockOf } from "./stock.js";

const WIDE = "(min-width: 992px)";

// How many of each group show; the rest wait for a longer query.
const SHOW = { answers: 3, products: 8, pages: 6, news: 3 };

const money = (n) => `$${Number.isInteger(n) ? n : Number(n).toFixed(2)}`;

// A result's second line. Drafts for James.
const detail = (entry, live) => {
  if (entry.kind === "product") {
    return `${money(entry.price)} · ${stockOf(entry, live).label}`;
  }
  if (entry.kind === "section") return entry.page || "";
  if (entry.kind === "news") return entry.date || "";

  return entry.detail || entry.snippet || "";
};

export const wireSiteSearch = () => {
  const root = document.querySelector("[data-site-find]");

  if (!root) return;

  const q = (selector) => root.querySelector(selector);
  const input = q(".site-find-input");
  const panel = q("[data-find-panel]");
  const list = q("[data-find-list]");
  const none = q("[data-find-none]");
  const said = q("[data-find-query]");
  const status = q("[data-find-status]");
  const clear = q("[data-find-clear]");
  const cancel = q("[data-find-cancel]");
  const groupShape = q("[data-find-group]").content.firstElementChild;
  const optionShape = q("[data-find-option]").content.firstElementChild;
  const opener = document.querySelector("[data-search-open]");
  const scrim = document.querySelector("[data-find-scrim]");
  const header = root.closest("header");
  const wide = matchMedia(WIDE);

  // Live stock, { sku: { inStock, available } }, from /api/stock on
  // the first open, as the order page asks for it (James, 2026-11-21,
  // #402; as the palette did, #267, #492). Until it answers, or if it
  // fails, results read the index's stock word (stock.js).
  let live = null;
  let stocking = null;

  let indexed = null;
  let loading = null;
  let options = [];
  let active = -1;
  let barOpen = false;

  // Engaged: the field has the focus from 992 px, the bar is open
  // below.
  const engaged = () => (wide.matches
    ? document.activeElement === input : barOpen);

  const setActive = (i, { scroll = true } = {}) => {
    active = options.length ? i : -1;
    options.forEach(({ el }, n) => {
      el.setAttribute("aria-selected", String(n === active));
    });
    if (active === -1) {
      input.removeAttribute("aria-activedescendant");

      return;
    }
    input.setAttribute("aria-activedescendant", options[active].el.id);
    if (scroll) options[active].el.scrollIntoView({ block: "nearest" });
  };

  const hidePanel = () => {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    setActive(-1);
  };

  const option = (entry) => {
    const el = optionShape.cloneNode(true);

    el.id = `site-find-option-${options.length}`;
    el.dataset.kind = entry.kind;
    if (entry.sku) el.dataset.sku = entry.sku;
    if (entry.kind === "product" && stockOf(entry, live).out) {
      el.dataset.stock = "out";
    }
    el.querySelector(".site-find-title").textContent = entry.title;
    el.querySelector(".site-find-detail").textContent = detail(entry, live);
    options.push({ el, entry });

    return el;
  };

  const render = () => {
    const query = input.value.trim();

    clear.hidden = !input.value;
    if (!query || !engaged()) {
      hidePanel();
      status.textContent = "";

      return;
    }
    // The index is on its way; it renders when it comes.
    if (!indexed) return;

    const groups = search(indexed, query).map((group) => ({
      ...group,
      entries: group.entries
        .filter((e) => e.kind !== "product" || listed(e, live))
        .slice(0, SHOW[group.key] || 5),
    })).filter((group) => group.entries.length);

    // Live stock arriving re-renders: the active result stays active.
    const was = options[active] && options[active].entry;

    options = [];
    list.replaceChildren(...groups.map((group) => {
      const el = groupShape.cloneNode(true);
      const name = el.firstElementChild;

      name.id = `site-find-group-${group.key}`;
      name.textContent = group.name;
      el.setAttribute("aria-labelledby", name.id);
      el.append(...group.entries.map(option));

      return el;
    }));

    const found = options.length;

    list.hidden = !found;
    none.hidden = found > 0;
    said.textContent = query;
    panel.hidden = false;
    input.setAttribute("aria-expanded", String(found > 0));

    const keep = was ? options.findIndex((o) => o.entry === was) : -1;

    if (keep === -1) list.scrollTop = 0;
    setActive(keep, { scroll: false });
    // Drafts for James.
    status.textContent = found
      ? `${found} ${found === 1 ? "result" : "results"}`
      : `No results for “${query}”`;
  };

  const load = () => {
    loading ||= fetch(root.dataset.index)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body) => {
        indexed = index(Array.isArray(body) ? body : body.entries);
        render();
      })
      // Tried again the next time search is opened or focused.
      .catch(() => {
        loading = null;
      });

    return loading;
  };

  // The region says data-stock="ready" once live stock is in, or has
  // failed and the index's word stands.
  const loadStock = () => {
    stocking ||= fetch("/api/stock", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        live = (body && body.items) || null;
      })
      .catch(() => {
        live = null;
      })
      .finally(() => {
        root.dataset.stock = "ready";
        render();
      });

    return stocking;
  };

  const openBar = () => {
    if (barOpen) return;
    barOpen = true;

    // Fixed under the header where it is now; the page under the
    // scrim stays put while the bar is open.
    const top = `${Math.max(0, header.getBoundingClientRect().bottom)}px`;

    root.style.setProperty("--find-top", top);
    scrim.style.setProperty("--find-top", top);
    root.classList.add("is-open");
    scrim.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    input.focus();
    load();
    loadStock();
    render();
  };

  const closeBar = ({ focus = true } = {}) => {
    if (!barOpen) return;
    barOpen = false;
    root.classList.remove("is-open");
    scrim.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    input.value = "";
    render();
    if (focus) opener.focus();
  };

  // Closes search: the panel from 992 px, the bar below.
  const close = (how) => (wide.matches ? hidePanel() : closeBar(how));

  // Opens a result. A link to this same page and hash still moves to
  // it: the order page listens for the hash (order/restock.js).
  const go = ({ url }) => {
    const to = new URL(url, location.href);

    close({ focus: false });
    if (wide.matches) input.blur();
    if (to.href === location.href && to.hash) {
      window.dispatchEvent(new HashChangeEvent("hashchange"));

      return;
    }
    location.assign(to.href);
  };

  input.addEventListener("focus", () => {
    load();
    loadStock();
    render();
  });
  input.addEventListener("click", () => {
    if (panel.hidden) render();
  });
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (panel.hidden) render();
      if (!options.length) return;

      const step = e.key === "ArrowDown" ? 1 : -1;
      const from = active === -1 && step === -1 ? 0 : active;

      setActive((from + step + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();

      const pick = options[active] || options[0];

      if (pick && !panel.hidden) go(pick.entry);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!wide.matches) closeBar();
      else if (!panel.hidden) hidePanel();
      else if (input.value) {
        input.value = "";
        render();
      }
    }
  });

  list.addEventListener("click", (e) => {
    const el = e.target.closest("[role='option']");
    const pick = el && options.find((o) => o.el === el);

    if (pick) go(pick.entry);
  });

  clear.addEventListener("click", () => {
    input.value = "";
    render();
    input.focus();
  });
  cancel.addEventListener("click", () => closeBar());
  opener?.addEventListener("click", () => (barOpen ? closeBar()
    : openBar()));

  // A tap on the scrim closes the bar, and lands nowhere else.
  scrim?.addEventListener("click", () => closeBar({ focus: false }));

  // A press anywhere else closes it too: the page is still there to
  // use from 992 px.
  document.addEventListener("pointerdown", (e) => {
    if (root.contains(e.target) || opener?.contains(e.target)
      || e.target === scrim) return;
    if (wide.matches) hidePanel();
    else closeBar({ focus: false });
  });

  // From 992 px the panel closes as the focus leaves search.
  root.addEventListener("focusout", (e) => {
    if (wide.matches && e.relatedTarget && !root.contains(e.relatedTarget)) {
      hidePanel();
    }
  });

  // Crossing 992 px puts the bar away.
  wide.addEventListener("change", () => {
    closeBar({ focus: false });
    hidePanel();
  });

  // Cmd or Ctrl K, a quiet shortcut.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
    e.preventDefault();
    if (wide.matches) {
      input.focus();
      input.select();
    } else if (barOpen) {
      closeBar();
    } else {
      openBar();
    }
  });
};
