// The cart's view: what touches the viewport, the clock and the
// pane's own motion (#477, docs/cart.md). cart/state.mjs decides the
// state and cart/cart.js writes it; this module feeds the decision and
// animates the result. It writes no height, floor or cap to CSS: the
// stylesheet (_cart.scss) lays the pane out from three raw viewport
// facts (--cart-vis, --cart-gap, --cart-kb) and the top bar's foot
// (--cart-bar), and everything measured here is measured for the
// decision or the animation alone, at a quiet moment, never written
// back for the layout to read.

import { keyboardInset, moreStop, visibleArea } from "../lib/cart-scroll.mjs";
import { strayed, touchKind } from "../lib/cart-touch.mjs";

// The width and height classes the state reads. The stylesheet's
// $cart-short and the xl breakpoint are the same queries.
export const COLUMN = "(min-width: 1200px)";
export const SHORT = "(max-height: 500px)";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// A CSS length from a custom property, as pixels: "9.25rem", "148px"
// or a bare number. `rootFont` is the root's font size in px.
export const toPx = (value, rootFont = 16) => {
  const text = String(value || "").trim();
  const n = parseFloat(text);

  if (!Number.isFinite(n)) return 0;
  if (text.endsWith("rem")) return n * rootFont;
  if (text.endsWith("em")) return n * rootFont;

  return n;
};

// What the floating pane rests on, from the foot of the layout
// viewport: the margin, the toolbar's gap and the keyboard. The safe
// area, which only CSS can read, is the one term left out, so a
// threshold built on this is off by it on a phone with a home
// indicator and Safari's bar hidden: the seam moves by that much and
// nothing else does.
export const restOf = ({ margin = 8, gap = 0, kb = 0 }) => margin + gap + kb;

const rootFont = () => parseFloat(
  getComputedStyle(document.documentElement).fontSize
) || 16;

const prop = (el, name) => el.style.getPropertyValue(name);

const setProp = (el, name, px) => {
  const next = `${Math.round(px)}px`;

  if (prop(el, name) !== next) el.style.setProperty(name, next);
};

// One listener on the visual viewport. iOS keeps the layout viewport
// at full height under the keyboard and shrinks only the visual one;
// a gap under a toolbar's worth is the toolbar, which the pane must
// rest above (James, #267), and one over it is the keyboard, which
// the pane rides up by. Writes the three raw facts to the pane and
// tells the caller when the keyboard's inset changes. The one scroll
// it ever makes: when the keyboard rises with the code field focused,
// the field is brought into its scroller's view once, since Chromium
// does not do that for a scroller that shrinks after the focus.
export const watchKeyboard = (pane, { onInset } = {}) => {
  const visual = window.visualViewport;

  if (!visual) return () => {};

  let before = 0;
  const sync = () => {
    const inset = keyboardInset(window.innerHeight, visual);
    const area = visibleArea(window.innerHeight, visual);

    setProp(pane, "--cart-kb", inset);
    setProp(pane, "--cart-gap", area.gap);
    setProp(pane, "--cart-vis", area.height);
    if (inset === before) return;

    const was = before;

    before = inset;
    if (inset > was) {
      const field = document.activeElement;

      if (field && pane.contains(field)
        && field.matches("[data-field='code']")) {
        requestAnimationFrame(() => field.scrollIntoView({ block: "nearest" }));
      }
    }
    if (onInset) onInset(inset, was);
  };

  visual.addEventListener("resize", sync);
  window.addEventListener("resize", sync);
  sync();

  return () => {
    visual.removeEventListener("resize", sync);
    window.removeEventListener("resize", sync);
  };
};

// Feeds the placement decision (state.mjs place) on every frame the
// page moves. `look` gets place()'s inputs and two more, slotBottom
// and short, and the caller applies the state. The slot's place is
// read from its anchor, the empty block before the pane (the slot
// itself has no box below xl); slotBottom is that place plus the
// pane's height. The pane's height is read only in refresh(), which
// the caller runs after a render or a fold has finished, never
// mid-animation; the closed height is the stylesheet's constant for
// this width, read then too. While the keyboard is up nothing is
// looked at: the room is not the pane's.
export const watchPlacement = (pane, slot, { bar = null, look }) => {
  const column = matchMedia(COLUMN);
  const short = matchMedia(SHORT);
  const anchor = slot.querySelector("[data-cart-anchor]") || slot;
  let height = 0;
  let closedH = 0;
  let tick = null;

  const measure = () => {
    height = pane.getBoundingClientRect().height;
    closedH = toPx(
      getComputedStyle(pane).getPropertyValue("--cart-closed-h"), rootFont()
    );
  };

  const run = () => {
    tick = null;

    if (bar) {
      const foot = bar.getBoundingClientRect().bottom;

      setProp(pane, "--cart-bar", Math.max(0, foot));
    }
    if (toPx(prop(pane, "--cart-kb")) > 0) return;

    const slotTop = anchor.getBoundingClientRect().top;
    const room = window.innerHeight - restOf({
      margin: 0.5 * rootFont(),
      gap: toPx(prop(pane, "--cart-gap")),
    });

    look({
      column: column.matches,
      short: short.matches,
      slotTop,
      slotBottom: slotTop + height,
      room,
      height,
      closedH,
    });
  };
  const schedule = () => {
    if (tick === null) tick = requestAnimationFrame(run);
  };
  const refresh = () => {
    measure();
    run();
  };
  // The chrome eases between floating and settled, and the pane's
  // height with it: measure again when it has.
  const eased = (e) => {
    if (e.target === pane && e.propertyName === "padding-top") refresh();
  };

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", refresh);
  pane.addEventListener("transitionend", eased);
  column.addEventListener("change", refresh);
  short.addEventListener("change", refresh);
  refresh();

  return {
    refresh,
    dispose: () => {
      cancelAnimationFrame(tick);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", refresh);
      pane.removeEventListener("transitionend", eased);
      column.removeEventListener("change", refresh);
      short.removeEventListener("change", refresh);
    },
  };
};

// Eases the pane's height across a change the caller applies: a fold,
// lines coming or going, a fill or an emptying. The content is laid
// out at the new height at once; the pane's own edge follows. A
// floating sheet rests on its foot, so it grows upward. Nothing under
// reduced motion, and nothing when the change moves nothing. Resolves
// when the pane is still, so the caller can refresh the placement.
export const animateFold = (pane, apply, { reduce = reduced() } = {}) => {
  const from = pane.getBoundingClientRect().height;

  if (pane.currentEase) pane.currentEase.cancel();
  apply();

  const to = pane.getBoundingClientRect().height;

  if (reduce || !from || !to || Math.abs(to - from) < 1
    || typeof pane.animate !== "function") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const ease = pane.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.25, 1)" }
    );

    pane.currentEase = ease;
    const done = () => {
      if (pane.currentEase === ease) pane.currentEase = null;
      resolve();
    };

    ease.onfinish = done;
    ease.oncancel = done;
  });
};

// The "N more" pills and the fades at the list's edges, kept in step
// with the list's own scrolling and size. `wrap` is the scroller
// around the list that carries the fades and the pills.
export const watchList = (list, wrap, { more, moreTop }) => {
  const rows = () => Array.from(list.querySelectorAll(".order-cart-item"))
    .map((li) => ({
      top: li.offsetTop - list.offsetTop,
      bottom: li.offsetTop - list.offsetTop + li.offsetHeight,
    }));
  let glide = null;

  const sync = () => {
    // Room for the pills above and below the rows, only while the
    // rows overflow. The strip is counted back first: taken from the
    // rows, it kept them overflowing once a pane in mid-opening had
    // let them (#278).
    const strip = wrap.hasAttribute("data-scroll")
      ? parseFloat(getComputedStyle(wrap).paddingBottom) || 0 : 0;

    wrap.toggleAttribute(
      "data-scroll", list.scrollHeight > list.clientHeight + strip + 1
    );

    const seen = list.scrollTop + list.clientHeight;
    const hasMore = seen < list.scrollHeight - 1;
    const all = rows();
    const below = all.filter((r) => r.bottom > seen + 1).length;
    const above = all.filter((r) => r.bottom <= list.scrollTop + 1).length;

    wrap.toggleAttribute("data-top", list.scrollTop > 0);
    wrap.toggleAttribute("data-more", hasMore);
    // A hidden pill keeps its last count: it never reads "0 more".
    more.hidden = !hasMore || below === 0;
    if (!more.hidden) more.textContent = `${below} more ↓`;
    moreTop.hidden = list.scrollTop <= 0 || above === 0;
    if (!moreTop.hidden) moreTop.textContent = `${above} more ↑`;
  };

  // The list glides to the row that was hidden, landing on it
  // exactly: a drive of our own, since the browser's smooth scroll
  // overshot on iOS and snapped back (#366).
  const scrollMore = (dir) => {
    const to = moreStop(rows(), {
      top: list.scrollTop, height: list.clientHeight, full: list.scrollHeight,
    }, dir);
    const from = list.scrollTop;

    cancelAnimationFrame(glide);
    if (to === from) return;
    if (reduced()) {
      list.scrollTop = to;

      return;
    }

    const began = performance.now();
    const span = Math.min(420, 160 + Math.abs(to - from) * 0.8);
    const stop = () => cancelAnimationFrame(glide);
    const step = (now) => {
      const t = Math.min(1, (now - began) / span);

      list.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) glide = requestAnimationFrame(step);
    };

    list.addEventListener("touchstart", stop, { once: true, passive: true });
    list.addEventListener("wheel", stop, { once: true, passive: true });
    glide = requestAnimationFrame(step);
  };

  const down = () => scrollMore(1);
  const up = () => scrollMore(-1);
  const sizes = new ResizeObserver(sync);

  list.addEventListener("scroll", sync, { passive: true });
  more.addEventListener("click", down);
  moreTop.addEventListener("click", up);
  sizes.observe(list);
  sync();

  return {
    sync,
    dispose: () => {
      cancelAnimationFrame(glide);
      sizes.disconnect();
      list.removeEventListener("scroll", sync);
      more.removeEventListener("click", down);
      moreTop.removeEventListener("click", up);
    },
  };
};

// Scrolls the list, and only the list, to a line.
export const revealLine = (list, row) => {
  if (!row) return;

  const top = row.offsetTop - list.offsetTop;

  if (top < list.scrollTop
    || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = Math.max(0, top - 8);
  }
};

// The Hide/Show pill pulses: "teach" the first time, three pairs
// (#278), "once" on a later Add. With reduced motion it holds a still
// emphasis for a moment instead. A timer, not animationend, ends it:
// the still one has no animation to end.
const PULSE_MS = { teach: 4400, once: 520, still: 2600 };

export const pulsePill = (pill, kind) => {
  clearTimeout(pill.pulseTimer);
  pill.removeAttribute("data-pulse");
  void pill.offsetWidth;
  pill.setAttribute("data-pulse", kind);
  pill.pulseTimer = setTimeout(() => {
    pill.removeAttribute("data-pulse");
  }, PULSE_MS[reduced() ? "still" : kind]);
};

// Rings the whole pane in the brand green for a moment (#337). A
// timer, not animationend, ends it: under reduced motion the ring is
// still and has no animation to end.
const RING_MS = 1600;

export const ringCart = (pane) => {
  clearTimeout(pane.ringTimer);
  pane.classList.remove("is-ringed");
  void pane.offsetWidth;
  pane.classList.add("is-ringed");
  pane.ringTimer = setTimeout(() => {
    pane.classList.remove("is-ringed");
  }, RING_MS);
};

// The strip's word for an Add while the pane is closed.
export const showAdded = (box, text, { ms = 2600 } = {}) => {
  clearTimeout(box.addedTimer);
  box.querySelector("[data-cart-added]").textContent = text;
  box.setAttribute("data-show", "");
  box.addedTimer = setTimeout(() => box.removeAttribute("data-show"), ms);
};

// The first Add's lesson: the pane stays open on the new line for the
// dwell, then onShut runs and the pill pulses in three pairs. The pane
// is the customer's once they tap or click in it (keep); a touch is
// judged when it ends, since a scroll lands as a touch too (#473): a
// tap keeps the pane, a scroll (one the browser cancels, or one that
// strays past the slop) leaves the timer to shut it. A finger still
// down when the time is up has the last word.
export const teach = (pane, pill, { dwell, onShut }) => {
  let touch = null;
  let timer = null;
  let live = true;
  const point = (e) => ({ x: e.clientX, y: e.clientY });
  const mine = (e) => touch && e.pointerId === touch.id;

  const end = () => {
    live = false;
    clearTimeout(timer);
    pane.removeEventListener("pointerdown", down);
    pane.removeEventListener("pointermove", move);
    pane.removeEventListener("pointerup", ended);
    pane.removeEventListener("pointercancel", ended);
  };
  const shut = () => {
    if (!live) return;
    end();
    onShut();
    pulsePill(pill, "teach");
  };
  const keep = () => {
    if (!live) return;
    end();
  };

  const down = (e) => {
    if (e.pointerType !== "touch") {
      keep();

      return;
    }
    touch = {
      id: e.pointerId,
      start: point(e),
      far: 0,
      due: Boolean(touch && touch.due),
    };
  };
  const move = (e) => {
    if (!mine(e)) return;
    touch.far = strayed(touch.start, point(e), touch.far);
  };
  const ended = (e) => {
    if (!mine(e)) return;

    const t = touch;
    const cancelled = e.type === "pointercancel";

    touch = null;
    if (!cancelled) t.far = strayed(t.start, point(e), t.far);
    if (touchKind({ cancelled, far: t.far }) === "tap") keep();
    else if (t.due) shut();
  };

  pane.addEventListener("pointerdown", down, { passive: true });
  pane.addEventListener("pointermove", move, { passive: true });
  pane.addEventListener("pointerup", ended, { passive: true });
  pane.addEventListener("pointercancel", ended, { passive: true });
  timer = setTimeout(() => {
    if (touch) touch.due = true;
    else shut();
  }, dwell);

  return { keep, cancel: keep };
};

// A control the Tab key reaches under the floating pane scrolls up
// clear of it, never under the top bar (#159, WCAG 2.4.11). The pane's
// own are its own, and a scroller taller than the room is left where
// it is. The pane may grow once the bar sticks, so it looks again a
// frame later.
export const clearFocusUnder = (pane, bar = null) => {
  const clear = (el) => {
    if (pane.dataset.placement !== "floating" || pane.contains(el)
      || document.activeElement !== el) return;

    const r = el.getBoundingClientRect();
    const floor = pane.getBoundingClientRect().top;
    const ceiling = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;

    if (r.height > (floor - ceiling) / 2) return;

    const over = Math.min(r.bottom + 12 - floor, r.top - ceiling - 12);

    if (over > 0) window.scrollBy({ top: over, behavior: "instant" });
  };
  const onFocus = (e) => {
    clear(e.target);
    requestAnimationFrame(() => requestAnimationFrame(() => clear(e.target)));
  };

  document.addEventListener("focusin", onFocus);

  return () => document.removeEventListener("focusin", onFocus);
};
