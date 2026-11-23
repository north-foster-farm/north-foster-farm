// The section on screen, named in three places: the sidebar's outline
// from lg up, the phone's sticky bar below lg, and the total bar from
// lg to xl (docs/refactors/order-form.md, phase 1). Bootstrap's spy
// only hears sections crossing a band, so a fast scroll left a stale
// name, and the last section, too short to reach the band, never lit
// (#204). This asks where each section is on every frame the page
// moves; section-pick.mjs chooses.

import { all } from "./dom.js";
import {
  barEdge, barTitle, inCatalog, pickSection,
} from "./section-pick.mjs";

// Brings the rail's lit link into view inside whatever box scrolls the
// rail, never the page. scrollIntoView moved Chromium's Tab starting
// point to the link, so on load the first Tab skipped the skip link
// for the link after it (#291).
export const keepInRail = (link) => {
  let box = link.parentElement;

  while (box && box !== document.body) {
    const { overflowY } = getComputedStyle(box);

    const scrolls = /auto|scroll/.test(overflowY);

    if (scrolls && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) return;

  const a = link.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const by = a.top < b.top ? a.top - b.top
    : a.bottom > b.bottom ? a.bottom - b.bottom : 0;

  if (by) box.scrollBy({ top: by, behavior: "smooth" });
};

// The outline's links with their sections; each category's link, by
// its section; the catalog's rows, top to bottom, each with its
// category's link; and the catalog's own link.
const outline = (nav, catalog) => {
  const sections = all(nav, "a")
    .map((link) => ({
      link, target: document.querySelector(link.hash),
    }))
    .filter(({ target }) => target);
  const cats = new Map(sections
    .filter(({ target }) => target.classList.contains("order-cat"))
    .map(({ link, target }) => [target, link]));
  const rows = all(catalog, ".order-item").map((el) => ({
    el, cat: cats.get(el.closest(".order-cat")),
  }));
  const catalogLink = sections
    .find(({ target }) => target === catalog)?.link;

  return { sections, cats, rows, catalogLink };
};

// What the spy reads, found once.
const findParts = () => {
  const nav = document.getElementById("order-nav");
  const catalog = document.getElementById("order-catalog");

  return {
    nav,
    catalog,
    titles: all(document, "[data-topbar-title]"),
    bars: all(document, ".order-topbar, .order-total-bar"),
    heading: document.querySelector(".page-heading h1"),
    wide: window.matchMedia("(min-width: 992px)"),
    xl: window.matchMedia("(min-width: 1200px)"),
    ...outline(nav, catalog),
    cartHeading: document.getElementById("order-cart-heading"),
  };
};

// Mark the link and its parent in the outline (Catalog, over a
// category).
const mark = (parts, link) => {
  const parent = link.closest(".order-side-sub")
    ?.closest(".nav-item").querySelector(":scope > .nav-link");

  for (const a of all(parts.nav, ".nav-link")) {
    a.classList.toggle("active", a === link || a === parent);
  }
  if (parts.wide.matches) keepInRail(link);
};

// The phone bar casts its shadow only once stuck; at rest it lies flat
// under the header (O5). Then each bar as barEdge reads it.
const measureBars = (bars) => {
  for (const bar of bars) {
    if (bar.classList.contains("order-topbar")) {
      bar.dataset.stuck = String(bar.getBoundingClientRect().top <= 0.5);
    }
  }

  return bars.map((bar) => {
    const r = bar.getBoundingClientRect();

    return {
      shown: Boolean(bar.offsetParent)
        && getComputedStyle(bar).opacity !== "0",
      top: r.top,
      bottom: r.bottom,
    };
  });
};

// Each section as pickSection reads it. The floating cart is at the
// foot of the screen, not at its place in the page, so it counts only
// once settled, and settled it begins at its heading, above the pane.
// From xl it is a column stuck beside the others and never counts.
const measureSections = (parts) => parts.sections.map(({ link, target }) => {
  const cart = target.id === "order-cart";
  const box = cart ? parts.cartHeading : target;
  const shown = box.getClientRects().length > 0;

  return {
    key: link,
    stuck: target.dataset.stuck === "true",
    cart,
    shown,
    top: shown ? box.getBoundingClientRect().top : 0,
  };
});

// Within the catalog, its rows name the category (inCatalog): a
// section's top crossing the line named it too late, after the gap
// above its heading, while the rows under the bar were already its own
// (#274). Past its rows the catalog names no category (#702).
const narrow = (parts, current, edge) => {
  const inside = current && (current.hash === `#${parts.catalog.id}`
    || parts.cats.has(document.querySelector(current.hash)));

  if (!inside) return current;

  return inCatalog({
    given: current,
    catalog: parts.catalogLink,
    rows: parts.rows.map(({ el, cat }) => {
      const { top, bottom } = el.getBoundingClientRect();

      return { cat, top, bottom };
    }),
    edge,
    screen: window.innerHeight,
  });
};

// The section's name in the bars, a category's with the double
// chevron.
const drawTitles = (parts, current) => {
  const name = current
    ? current.dataset.heading || current.textContent.trim()
    : parts.heading ? parts.heading.textContent.trim() : "";
  const cat = !!current && current.hash.startsWith("#cat-");

  for (const title of parts.titles) {
    const phone = Boolean(title.closest(".order-topbar"));
    const text = barTitle({ name, cat, phone });

    if (title.textContent !== text) title.textContent = text;
    title.parentElement.toggleAttribute("data-cat", cat);
  }
};

const update = (spy) => {
  const { parts } = spy;

  spy.tick = null;

  const column = parts.xl.matches;
  const edge = barEdge(measureBars(parts.bars));
  const end = window.innerHeight + window.scrollY
    >= document.documentElement.scrollHeight - 2;
  const current = narrow(parts, pickSection({
    sections: measureSections(parts), line: edge + 24, end,
    screen: window.innerHeight, column,
  }), edge);

  if (current && current !== spy.shown) mark(parts, current);
  spy.shown = current || spy.shown;
  drawTitles(parts, current);
};

export const watchSections = () => {
  const spy = { parts: findParts(), shown: null, tick: null };
  const onScroll = () => {
    if (spy.tick === null) spy.tick = requestAnimationFrame(() => update(spy));
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update(spy);
};
