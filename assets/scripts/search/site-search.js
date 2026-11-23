// The site search (partials/search/field.html, #402, #913): an ARIA 1.2
// combobox over /search.json, closed to the header's magnifier at
// every width. The magnifier opens it and closes it again, named
// "Search" or "Close search" to match. From 992 px it unfolds a field
// in the header row, its results in a panel under it; below that a bar
// under the header, over a scrim, with Cancel. The index is fetched
// the first time search is opened, never on load. Results come grouped
// (match.js); arrows move the active one while the focus stays in the
// field, and Enter or a click opens one. A product goes to its row on
// the order page; there is no Add. Esc, Cancel, X or a tap outside
// closes search. From 992 px, Esc or X closes the results and leaves
// the focus in the field, which folds away once the focus leaves it
// (_search.scss); typing there opens search again, and a second Esc
// closes it and hands the focus back to the magnifier.

import { index, search } from "./match.js";
import { readStock } from "./live-stock.js";
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

// Search's open state, on the region, the scrim and the magnifier,
// which says what pressing it does (#913). The CSS animates the change.
const openState = ({ root, scrim, opener, wide }) => {
  let open = false;

  return {
    get isOpen() {
      return open;
    },
    mark(now) {
      open = now;
      root.classList.toggle("is-open", now);
      scrim?.classList.toggle("is-open", now && !wide.matches);
      opener?.setAttribute("aria-expanded", String(now));
      // Drafts for James.
      opener?.setAttribute("aria-label", now ? "Close search" : "Search");
    },
  };
};

// Below 992 px the bar is fixed under the header where it is now; the
// page under the scrim stays put while it is open.
const placeBar = (root, scrim) => {
  const bottom = root.closest("header").getBoundingClientRect().bottom;
  const top = `${Math.max(0, bottom)}px`;

  root.style.setProperty("--find-top", top);
  scrim?.style.setProperty("--find-top", top);
};

// Calls back only when the width truly crosses the breakpoint: Chrome
// can fire a change with none, as when the viewport is reset (#913).
const onCrossing = (query, back) => {
  let was = query.matches;

  query.addEventListener("change", () => {
    if (query.matches === was) return;
    was = query.matches;
    back();
  });
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
  const wide = matchMedia(WIDE);
  const state = openState({ root, scrim, opener, wide });

  // Live stock, { sku: { inStock, available } }, from /api/stock on
  // the first open, as the order page asks for it (James, 2026-11-21,
  // #402; as the palette did, #267, #492). Until it answers, or if it
  // fails, results read the index's stock word (stock.js).
  let live = null;

  let indexed = null;
  let loading = null;
  let options = [];
  let active = -1;

  // Engaged: search is open, and from 992 px the field has the focus.
  const engaged = () => state.isOpen
    && (!wide.matches || document.activeElement === input);

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

  // Each time the field takes the focus (#908): the order page's own
  // reader there, else a check of its own, under the same 15-second
  // floor (live-stock.js). The region says data-stock="ready" once live
  // stock is in, or has failed and the index's word stands.
  const loadStock = () => readStock()
    .then((items) => {
      live = items;
    })
    .catch(() => {
      live = null;
    })
    .finally(() => {
      root.dataset.stock = "ready";
      render();
    });

  const open = () => {
    if (state.isOpen) return;
    if (!wide.matches) placeBar(root, scrim);
    state.mark(true);
    input.focus();
    load();
    loadStock();
    render();
  };

  // Closes search, the field held open by the focus included.
  const close = ({ focus = true } = {}) => {
    if (!state.isOpen && !root.contains(document.activeElement)) {
      return;
    }
    state.mark(false);
    input.value = "";
    render();
    if (focus) opener?.focus();
    else if (root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  };

  // From 992 px Esc and X close the results and leave the field where
  // the focus is (see the top of this file).
  const release = () => {
    state.mark(false);
    hidePanel();
  };

  // Opens a result. A link to this same page and hash still moves to
  // it: the order page listens for the hash (order/restock.js).
  const go = ({ url }) => {
    const to = new URL(url, location.href);

    close({ focus: false });
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
  // Typing in a field Esc left open opens search again.
  input.addEventListener("input", () => {
    if (!state.isOpen) state.mark(true);
    render();
  });
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
      if (wide.matches && !panel.hidden) release();
      else close();
    }
  });

  list.addEventListener("click", (e) => {
    const el = e.target.closest("[role='option']");
    const pick = el && options.find((o) => o.el === el);

    if (pick) go(pick.entry);
  });

  clear.addEventListener("click", () => {
    input.value = "";
    release();
    render();
    input.focus();
  });
  cancel.addEventListener("click", () => close());
  opener?.addEventListener("click", () => (state.isOpen ? close() : open()));

  // A tap on the scrim closes the bar, and lands nowhere else.
  scrim?.addEventListener("click", () => close({ focus: false }));

  // A press anywhere else closes it too: from 992 px the page is still
  // there to use.
  document.addEventListener("pointerdown", (e) => {
    if (root.contains(e.target) || opener?.contains(e.target)
      || e.target === scrim) return;
    close({ focus: false });
  });

  // From 992 px the panel closes as the focus leaves search, which
  // stays open; a field Esc left open empties as it folds away.
  root.addEventListener("focusout", (e) => {
    if (!wide.matches || !e.relatedTarget
      || root.contains(e.relatedTarget)) return;
    hidePanel();
    if (!state.isOpen) input.value = "";
  });

  // Crossing 992 px puts search away.
  onCrossing(wide, () => {
    close({ focus: false });
    hidePanel();
  });

  // Cmd or Ctrl K, a quiet shortcut: it opens search, and closes the
  // bar below 992 px.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
    e.preventDefault();
    if (!state.isOpen) {
      open();
    } else if (wide.matches) {
      input.focus();
      input.select();
    } else {
      close();
    }
  });
};
