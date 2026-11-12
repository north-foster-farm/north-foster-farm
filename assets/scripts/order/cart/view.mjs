// The cart's view: what touches the viewport, the clock and the
// pane's own motion (#477, docs/cart.md). cart/state.mjs decides the
// state and cart/cart.js writes it; this module feeds the decision and
// animates the result. It writes no height, floor or cap to CSS: the
// stylesheet (_cart.scss) lays the pane out from three raw viewport
// facts (--cart-vis, --cart-gap, --cart-kb) and the top bar's foot
// (--cart-bar), and everything measured here is measured for the
// decision or the animation alone, at a quiet moment, never written
// back for the layout to read.

import {
  clearBy, keyboardInset, moreStop, visibleArea,
} from "../lib/cart-scroll.mjs";
import { strayed, touchKind } from "../lib/cart-touch.mjs";

// The width and height classes the state reads. The stylesheet's
// $cart-short and the xl breakpoint are the same queries.
export const COLUMN = "(min-width: 1200px)";
export const SHORT = "(max-height: 500px)";
// The one-column sheet: the stylesheet's $cart-sheet. The rules for a
// scroll (#559) and the motion of its parts are the sheet's alone; the
// tablet's panel keeps its own.
export const SHEET = "(max-width: 575.98px), "
  + "(max-width: 1199.98px) and (max-height: 500px)";

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
// tells the caller when the keyboard's inset changes. The visible
// height (--cart-vis) is written only while the keyboard is up (#559):
// Safari's toolbar grows and shrinks on a 10px scroll, and a cap that
// followed it moved the list's height, its scroll and its fades while
// the page scrolled. Without it the caps read 100svh, the height with
// the toolbar showing, which never changes as the page scrolls. The
// one scroll it ever makes: when the keyboard rises with the code
// field focused, the field is brought into its scroller's view once,
// since Chromium does not do that for a scroller that shrinks after
// the focus.
export const watchKeyboard = (pane, { onInset } = {}) => {
  const visual = window.visualViewport;

  if (!visual) return () => {};

  let before = 0;
  const sync = () => {
    const inset = keyboardInset(window.innerHeight, visual);
    const area = visibleArea(window.innerHeight, visual);

    // The keyboard moves the pane at once: data-keyboard, while it is
    // up and for a frame after, sets aside the ease the floating sheet
    // gives any other change of where it rests (_cart.scss, #559).
    if (inset > 0 || before > 0) {
      cancelAnimationFrame(pane.keyboardTick);
      pane.setAttribute("data-keyboard", "");
    }
    setProp(pane, "--cart-kb", inset);
    setProp(pane, "--cart-gap", area.gap);
    if (inset > 0) setProp(pane, "--cart-vis", area.height);
    else pane.style.removeProperty("--cart-vis");
    if (inset === 0 && pane.hasAttribute("data-keyboard")) {
      pane.keyboardTick = requestAnimationFrame(() => {
        pane.keyboardTick = requestAnimationFrame(() => {
          pane.removeAttribute("data-keyboard");
        });
      });
    }
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
export const watchPlacement = (pane, slot, { bar: given, look }) => {
  const column = matchMedia(COLUMN);
  const short = matchMedia(SHORT);
  const anchor = slot.querySelector("[data-cart-anchor]") || slot;
  // The phone's top bar, whose foot the pane's room ends at.
  const bar = given === undefined
    ? document.querySelector(".order-topbar") : given;
  let height = 0;
  let closedH = 0;
  let tick = null;

  // The closed height the lift-off threshold uses must never exceed
  // the height the pane then has closed: a settle at `room - height`
  // and a lift-off at `room - closedH` would overlap, and a scroll
  // that stops in the overlap would flip the pane back and forth. So
  // it is the pane's own height, cached whenever it is measured
  // floating and closed, and the stylesheet's constant, a lower
  // bound, only until then (and again after a width change).
  let closedSeen = 0;
  const measure = () => {
    height = pane.getBoundingClientRect().height;
    if (pane.dataset.placement === "floating"
      && pane.dataset.fold === "closed") {
      closedSeen = height;
    }
    closedH = closedSeen || toPx(
      getComputedStyle(pane).getPropertyValue("--cart-closed-h"), rootFont()
    );
  };
  const forget = () => {
    closedSeen = 0;
    refresh();
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
  window.addEventListener("resize", forget);
  pane.addEventListener("transitionend", eased);
  column.addEventListener("change", forget);
  short.addEventListener("change", forget);
  refresh();

  return {
    refresh,
    dispose: () => {
      cancelAnimationFrame(tick);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", forget);
      pane.removeEventListener("transitionend", eased);
      column.removeEventListener("change", forget);
      short.removeEventListener("change", forget);
    },
  };
};

// Whether a page scroll is the person's own (#559): one that follows
// a finger, a wheel or a scrolling key outside the pane, or the
// momentum that carries on from one. A scroll the page makes (Proceed
// to checkout, the bar's total going back to the cart, Tab moving a
// field clear of the pane, the code field coming into view) has none
// of those before it. Inside the pane a touch or a wheel scrolls the
// pane, never the page (overscroll-behavior: contain).
const SCROLL_KEYS = new Set([
  "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ",
]);

// How long after the person's last input, or the last scroll that was
// theirs, a scroll still counts: momentum sends one a frame.
export const OWN_MS = 150;

export const ownScroll = ({ now, input, last, touching }) => touching
  || now - input < OWN_MS || now - last < OWN_MS;

// Calls `look({ y, counts })` once a frame while the page scrolls, and
// `onMove` at once on the first sign of a scroll (a finger moving, a
// wheel, a scrolling key, any scroll at all, the page's or a
// scroller's), before the frame that draws it.
export const watchScroll = (pane, { look, onMove = () => {} }) => {
  let input = -Infinity;
  let last = -Infinity;
  let touching = false;
  let tick = null;
  const outside = (e) => !(e.target instanceof Node && pane.contains(e.target));
  const editable = (el) => el instanceof Element
    && el.matches("input, textarea, select, [contenteditable]");

  const touchStart = (e) => {
    if (!outside(e)) return;
    touching = true;
    input = performance.now();
  };
  const touchEnd = () => {
    if (!touching) return;
    touching = false;
    input = performance.now();
  };
  const moved = (e) => {
    if (outside(e)) input = performance.now();
    onMove();
  };
  // Space on a button presses it, and scrolls nothing.
  const key = (e) => {
    if (!SCROLL_KEYS.has(e.key) || editable(e.target)) return;
    if (e.key === " " && e.target instanceof Element
      && e.target.closest("button, a, [role='button']")) return;
    if (outside(e)) input = performance.now();
    onMove();
  };
  const run = () => {
    tick = null;

    const now = performance.now();
    const counts = ownScroll({ now, input, last, touching });

    if (counts) last = now;
    look({ y: window.scrollY, counts });
  };
  const scrolled = () => {
    onMove();
    if (tick === null) tick = requestAnimationFrame(run);
  };
  const any = () => onMove();
  const opts = { capture: true, passive: true };

  document.addEventListener("touchstart", touchStart, opts);
  document.addEventListener("touchmove", moved, opts);
  document.addEventListener("touchend", touchEnd, opts);
  document.addEventListener("touchcancel", touchEnd, opts);
  document.addEventListener("wheel", moved, opts);
  document.addEventListener("keydown", key, opts);
  // Captured, a scroller's scroll as well as the page's.
  document.addEventListener("scroll", any, opts);
  window.addEventListener("scroll", scrolled, { passive: true });

  return () => {
    cancelAnimationFrame(tick);
    document.removeEventListener("touchstart", touchStart, opts);
    document.removeEventListener("touchmove", moved, opts);
    document.removeEventListener("touchend", touchEnd, opts);
    document.removeEventListener("touchcancel", touchEnd, opts);
    document.removeEventListener("wheel", moved, opts);
    document.removeEventListener("keydown", key, opts);
    document.removeEventListener("scroll", any, opts);
    window.removeEventListener("scroll", scrolled);
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
    // How many eases have started, for the specs: an ease is over
    // before they can see it run.
    pane.eases = (pane.eases || 0) + 1;
    const done = () => {
      if (pane.currentEase === ease) pane.currentEase = null;
      resolve();
    };

    ease.onfinish = done;
    ease.oncancel = done;
  });
};

// The sheet's one rule for motion (#559): the contents and the
// container move together. The pane is never given a height. Each
// part that comes, goes or changes size eases its own box between its
// two sizes, every part on one curve and one clock from the same
// frame, so the pane, which is only as tall as its parts, moves with
// them on every frame. A part that goes stays drawn as it was until it
// has shrunk to nothing, and is faded out early on; one that comes
// grows from nothing and fades in late (fadeFrames). The pane's own
// padding and borders, Clear cart, and on a lift-off the pane's place
// (paneFrames) ease on the same clock. The body's parts ease their
// height; the foot's two buttons ease their width, Expand or Hide
// coming and going on a settle or a lift-off while Proceed to checkout
// takes or gives its room, so the settled foot becomes the floating
// one and back.
// While the parts ease the body is held at its end, should it ever be
// taller than the room: the total row stays on the foot. Add, remove,
// clear, Expand, Hide, the minimize on scroll, the settle and the
// lift-off all go through here; nothing patches one of them alone.
// Resolves when every part is still. Under reduced motion it applies
// the change and nothing moves.
export const MOVE_MS = 420;
const MOVE_EASE = "cubic-bezier(0.2, 0.8, 0.25, 1)";
export const MOVE_ID = "cart-move";
const SIDEWAYS = ".order-cart-toggle, .order-cart-next";

const movers = (pane) => [
  ...(pane.querySelector("[data-cart-body]")?.children || []),
  ...(pane.querySelector("[data-part='foot']")?.children || []),
];

// What a part that comes or goes takes up besides its size: its
// padding, its borders and its margins, which display: none takes away
// in one frame. A body part's are above and below it, a foot button's
// beside it, where the foot's gap after it goes too (its right margin
// takes the gap back). Eased with the size, so nothing is left to snap
// when the ease ends (#559: the sums', the badges' and the shared
// row's padding, about 40px, dropped in the last frame of a minimize).
const ROOM = {
  down: [
    "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth",
    "marginTop", "marginBottom",
  ],
  across: [
    "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth",
    "marginRight",
  ],
};

// The scroller inside a part, which keeps one size while its part
// eases: see moveParts.
const HELD = "[data-cart-scroll]";

const outerHeight = (el) => (el && el.getClientRects().length
  ? el.getBoundingClientRect().height : 0);

const sizeOf = (el) => {
  const rects = el.getClientRects();

  if (!rects.length) return { shown: false, size: 0 };

  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const sideways = el.matches(SIDEWAYS);
  const room = Object.fromEntries(
    ROOM[sideways ? "across" : "down"].map((name) => [name, style[name]])
  );

  return {
    shown: true,
    size: sideways ? r.width : r.height,
    display: style.display,
    room,
    gap: sideways && el.nextElementSibling?.getClientRects().length
      ? parseFloat(getComputedStyle(el.parentElement).columnGap) || 0 : 0,
  };
};

// The keyframes for one part, from its two sizes (pure, for the unit
// tests). A body part eases its height; a sideways part (a foot
// button) its flex basis with its growth held, since a flex item's
// width is its basis. Coming or going, the room it takes besides its
// size (ROOM: padding, borders, margins, a foot button's gap) eases
// from or to nothing with it, so the pane's edge, the part and
// everything under it move on the same curve to the end. Its fade is
// fadeFrames', on its own timing.
export const moveFrames = (sideways, was, now) => {
  const fade = !was.shown || !now.shown;
  const seen = was.shown ? was : now;
  const frame = (size, gone) => {
    const f = sideways
      ? {
        flexGrow: 0, flexShrink: 0, flexBasis: `${size}px`, minWidth: "0px",
        maxWidth: "none",
      }
      : { height: `${size}px`, minHeight: "0px", maxHeight: "none" };

    if (!fade) return f;
    for (const [name, value] of Object.entries(seen.room || {})) {
      f[name] = gone ? "0px" : value;
    }
    if (sideways && gone) {
      f.marginRight = `${(parseFloat(seen.room?.marginRight) || 0)
        - (seen.gap || 0)}px`;
    }

    return f;
  };

  return [frame(was.size, !was.shown), frame(now.size, !now.shown)];
};

// Where on the shared curve a fade ends or begins (#559, round 3): what
// goes is gone by FADE_OUT of the way, and what comes shows from
// FADE_IN, so old and new contents are never on screen together (the
// clear's lines faded over the new total row) and a part that comes is
// most of its height before it shows (Expand's rows looked squeezed
// under Hide). Offsets on the eased progress: the curve starts fast,
// so FADE_OUT is about the first 85 ms and FADE_IN about the first
// 150 ms of MOVE_MS.
export const FADE_OUT = 0.6;
export const FADE_IN = 0.75;

// The opacity keyframes for a part that comes or goes (pure, for the
// unit tests); null for one that stays.
export const fadeFrames = (was, now) => {
  if (was.shown === now.shown) return null;
  if (now.shown) {
    return [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: FADE_IN },
      { opacity: 1, offset: 1 },
    ];
  }

  return [
    { opacity: 1, offset: 0 },
    { opacity: 0, offset: FADE_OUT },
    { opacity: 0, offset: 1 },
  ];
};

// The pane's own room, which a settle or a lift-off changes (the
// settled pane has no padding, and its border is thinner): eased with
// the parts on their clock, so the foot's width and the parts' widths
// move as one (#559, round 3: on a CSS clock of its own, the foot
// narrowed a frame ahead of its buttons, and Proceed to checkout
// wrapped onto a row of its own).
const CHROME = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "marginLeft", "marginRight",
];

const chromeOf = (pane) => {
  const style = getComputedStyle(pane);

  return Object.fromEntries(CHROME.map((name) => [name, style[name]]));
};

// The keyframes for the pane itself (pure, for the unit tests): its
// room where it changed, and `shift`, how far below its resting place
// the pane starts, eased away. Null when nothing changes.
//
// The shift is the lift-off's (#559, round 3). A floating pane rests
// on its foot (sticky), so on the frame an open settled cart lifted
// off, the pane, still as tall as the settled cart, jumped up over the
// catalog by all the height it had yet to lose, and shrank back down:
// two carts on screen for a third of a second. Started that far down
// and eased up as it shrinks, its top stays where the settled cart's
// was while the lines go and the total row and the foot rise into
// view, the settle run backwards.
export const paneFrames = (was, now, shift = 0) => {
  const from = {};
  const to = {};

  for (const name of CHROME) {
    if (was[name] !== undefined && was[name] !== now[name]) {
      from[name] = was[name];
      to[name] = now[name];
    }
  }
  if (Math.abs(shift) >= 0.5) {
    from.translate = `0 ${shift}px`;
    to.translate = "0 0";
  }

  return Object.keys(to).length ? [from, to] : null;
};

// How far below its resting place a floating pane must start so that
// its top stays where it was (see paneFrames), from its box before the
// change and after it. 0 when the pane is not floating after it (the
// settled pane keeps its top in the flow) or the shift is under half a
// pixel.
export const liftShift = ({ wasTop, wasHeight, nowBottom, floating }) => {
  if (!floating) return 0;

  const shift = wasTop - (nowBottom - wasHeight);

  return Math.abs(shift) < 0.5 ? 0 : shift;
};

// Whether a part moves, from its two sizes: half a pixel is rounding.
export const moves = (was, now) => (was.shown || now.shown)
  && Math.abs(was.size - now.size) >= 0.5;

// The part eases running on the pane, for stilled() and the specs.
export const moving = (pane) => pane.getAnimations({ subtree: true })
  .filter((a) => a.id === MOVE_ID);

// Clear cart, which stands astride the pane's edge and takes no room:
// where it stands and whether it shows.
const CLEAR = "[data-cart-clear]";

const pillOf = (el) => {
  if (!el || !el.getClientRects().length) return { shown: false };

  const style = getComputedStyle(el);

  return {
    shown: true, display: style.display, transform: style.transform,
    right: style.right,
  };
};

// Clear cart through a change (#559, round 3): one that goes stays
// where it stood, over the stylesheet's display: none and its new
// place, and fades by FADE_OUT (the clear's pill vanished in one frame
// with everything else); one that comes fades in at its new place; one
// that stays moves to its new place on the parts' curve. -> its
// animations, and what to undo at the end.
const movePill = (el, was, now, timing) => {
  if (!el || (!was.shown && !now.shown)) return { eases: [], undo: () => {} };
  if (was.shown && now.shown) {
    if (was.transform === now.transform && was.right === now.right) {
      return { eases: [], undo: () => {} };
    }

    return {
      eases: [el.animate([
        { transform: was.transform, right: was.right },
        { transform: now.transform, right: now.right },
      ], timing)],
      undo: () => {},
    };
  }
  if (!now.shown) {
    el.style.setProperty("display", was.display, "important");
    el.style.setProperty("transform", was.transform, "important");
    el.style.setProperty("right", was.right, "important");
  }

  return {
    eases: [el.animate(fadeFrames(was, now), timing)],
    undo: () => {
      for (const name of ["display", "transform", "right"]) {
        el.style.removeProperty(name);
      }
    },
  };
};

// Fades in words that changed with a move, Hide's or Expand's, as a
// part that comes fades in (#559, round 3: on the clear, Hide became
// Expand in the frame before anything eased). Nothing under reduced
// motion.
export const fadeInWords = (el, { reduce = reduced() } = {}) => {
  if (reduce || typeof el.animate !== "function") return;
  el.animate(fadeFrames({ shown: false }, { shown: true }), {
    duration: MOVE_MS, easing: MOVE_EASE, id: MOVE_ID,
  });
};

export const moveParts = (pane, apply, { reduce = reduced() } = {}) => {
  const parts = movers(pane);
  const was = parts.map(sizeOf);
  const heldWas = parts.map((el) => outerHeight(el.querySelector(HELD)));
  const clear = pane.querySelector(CLEAR);
  const pillWas = pillOf(clear);
  const box = pane.getBoundingClientRect();
  const chromeWas = chromeOf(pane);
  const floatingWas = pane.dataset.placement === "floating";

  // A newer change takes over from where the parts are now: their
  // sizes were read mid-ease, above, before the old eases go.
  for (const a of moving(pane)) a.cancel();
  if (pane.moveDone) pane.moveDone();
  apply();

  if (reduce || typeof pane.animate !== "function") return Promise.resolve();

  const floating = pane.dataset.placement === "floating";
  // A lift-off: the floating pane's cap is lifted while it eases, so
  // the pane is as tall as its parts on every frame and the shift that
  // holds its top is exact (the settled cart is uncapped, and capped
  // on the first frame its body scrolled and its height jumped).
  const lifting = floating && !floatingWas;

  if (lifting) pane.style.setProperty("max-height", "none");

  const now = parts.map(sizeOf);
  const pillNow = pillOf(clear);
  const chromeNow = chromeOf(pane);
  const paneNow = pane.getBoundingClientRect();
  const plan = parts
    .map((el, i) => ({
      el,
      was: was[i],
      now: now[i],
      held: el.querySelector(HELD),
      heldAt: Math.max(heldWas[i], outerHeight(el.querySelector(HELD))),
    }))
    .filter((p) => p.el.isConnected && moves(p.was, p.now));
  const shift = liftShift({
    wasTop: box.top,
    wasHeight: box.height,
    nowBottom: paneNow.bottom,
    floating,
  });
  const chrome = paneFrames(chromeWas, chromeNow, shift);
  const pillMoves = pillWas.shown !== pillNow.shown
    || (pillWas.shown && (pillWas.transform !== pillNow.transform
      || pillWas.right !== pillNow.right));

  if (!plan.length && !chrome && !pillMoves) {
    pane.style.removeProperty("max-height");

    return Promise.resolve();
  }

  const body = pane.querySelector("[data-cart-body]");
  let hold = null;
  const atEnd = () => {
    if (body && body.scrollHeight > body.clientHeight + 1) {
      body.scrollTop = body.scrollHeight;
    }
    hold = requestAnimationFrame(atEnd);
  };

  // A part that goes is drawn as it was, over the stylesheet's
  // display: none, until its ease is over; every part clips what is
  // past its easing edge. The items list inside the lines keeps the
  // larger of its two sizes while they ease, so the edge uncovers or
  // covers it and never squeezes it: its height, its scroll and its
  // fades are the ones it ends with (or had, going) on every frame, and
  // a settled list shows every line from the first frame.
  for (const { el, was: w, now: n, held, heldAt } of plan) {
    if (!n.shown) el.style.setProperty("display", w.display, "important");
    el.style.setProperty("overflow", "clip");
    if (held && heldAt > 0) {
      held.style.setProperty("flex", "none");
      held.style.setProperty("height", `${heldAt}px`);
    }
  }

  // Every ease on one clock and one curve, started in this frame: the
  // parts' sizes, their fades, the pane's own room and shift, and Clear
  // cart.
  const timing = { duration: MOVE_MS, easing: MOVE_EASE, id: MOVE_ID };
  const eases = plan.flatMap(({ el, was: w, now: n }) => {
    const fade = fadeFrames(w, n);

    return [
      el.animate(moveFrames(el.matches(SIDEWAYS), w, n), timing),
      ...(fade ? [el.animate(fade, timing)] : []),
    ];
  });

  if (chrome) eases.push(pane.animate(chrome, timing));

  const pill = movePill(clear, pillWas, pillNow, timing);

  eases.push(...pill.eases);

  // How many eases have started, for the specs: an ease is over
  // before they can see it run.
  pane.eases = (pane.eases || 0) + 1;
  atEnd();

  return new Promise((resolve) => {
    const done = () => {
      if (pane.moveDone !== done) return;
      pane.moveDone = null;
      cancelAnimationFrame(hold);
      for (const { el, held } of plan) {
        el.style.removeProperty("display");
        el.style.removeProperty("overflow");
        held?.style.removeProperty("flex");
        held?.style.removeProperty("height");
      }
      pill.undo();
      pane.style.removeProperty("max-height");
      resolve();
    };

    pane.moveDone = done;
    Promise.all(eases.map((e) => e.finished.catch(() => {}))).then(done);
  });
};

// Folds an open part of the shared row (#532): `is-shutting` plays its
// opening backwards (_cart.scss), and `apply` hides it once that is
// over. Under reduced motion `apply` runs at once. A second call while
// one runs gets the same promise, so the part shuts once.
export const shutShare = (part, apply, { reduce = reduced() } = {}) => {
  if (part.shutting) return part.shutting;
  if (reduce || typeof part.getAnimations !== "function") {
    apply();

    return Promise.resolve();
  }

  part.classList.add("is-shutting");
  // The part is styled before getAnimations() answers, so the closing
  // is among them. One cancelled, by a hide from elsewhere, is over too.
  part.shutting = Promise.all(
    part.getAnimations().map((a) => a.finished.catch(() => {}))
  ).then(() => {
    apply();
    part.classList.remove("is-shutting");
    part.shutting = null;
  });

  return part.shutting;
};

// Which "more" arrows show (#560): one wherever any part of the list
// lies past that edge, even a line only half under its fade. No count:
// counting whole rows missed the ones the fades half hide. A pixel's
// allowance at each end: iOS can rest a list at a fractional scrollTop.
export const moreShown = ({ top, height, full }) => ({
  up: top > 1,
  down: top + height < full - 1,
});

// The "more" arrows and the fades at the list's edges, kept in step
// with the list's own scrolling and size. `wrap` is the scroller
// around the list that carries the fades and the arrows. While
// `paused()` says the pane is moving, a change of size waits for the
// caller's sync at the end (#559): the list grows and shrinks with the
// pane, and the arrows and fades flickered on and off under it.
export const watchList = (list, wrap, {
  more, moreTop, paused = () => false,
}) => {
  const rows = () => Array.from(list.querySelectorAll(".order-cart-item"))
    .map((li) => ({
      top: li.offsetTop - list.offsetTop,
      bottom: li.offsetTop - list.offsetTop + li.offsetHeight,
    }));
  let glide = null;

  const sync = () => {
    // Room for the arrows above and below the rows, only while the
    // rows overflow. The strip is counted back first: taken from the
    // rows, it kept them overflowing once a pane in mid-opening had
    // let them (#278).
    const strip = wrap.hasAttribute("data-scroll")
      ? parseFloat(getComputedStyle(wrap).paddingBottom) || 0 : 0;

    wrap.toggleAttribute(
      "data-scroll", list.scrollHeight > list.clientHeight + strip + 1
    );

    const shown = moreShown({
      top: list.scrollTop, height: list.clientHeight, full: list.scrollHeight,
    });

    wrap.toggleAttribute("data-top", shown.up);
    wrap.toggleAttribute("data-more", shown.down);
    more.hidden = !shown.down;
    moreTop.hidden = !shown.up;
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
  // A frame later: sync moves the strip, which resizes the list, and
  // WebKit warns of a loop when that happens inside the observer.
  const sizes = new ResizeObserver(() => requestAnimationFrame(() => {
    if (!paused()) sync();
  }));

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
// dwell, then onShut runs (the caller closes the pane and pulses the
// pill in three pairs once it has shut). The pane
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
  // The caller closes the pane and pulses the pill once it has shut.
  const shut = () => {
    if (!live) return;
    end();
    onShut();
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

// How long after a focus a change in the page's height may still have
// pushed the control off the screen: a cart settling and opening, a
// list landing.
const SHIFT_MS = 1000;

// How soon after a Tab keydown a focus counts as one the Tab key moved.
// The browser moves the focus in the keydown's own task, so this is
// slack, not a wait.
const TAB_MS = 100;

// A control the Tab key reaches under the floating pane scrolls up
// clear of it, never under the top bar (#159, WCAG 2.4.11). The pane's
// own are its own, and a scroller taller than the room is left where
// it is. The pane may grow once the bar sticks, so it looks again a
// frame later.
//
// A control the Tab key moved to below the screen's foot scrolls up
// the same way, wherever the cart is (#549). WebKit keeps no scroll
// anchor, so a page that grows above the focus after the browser
// scrolled to it (the cart settling into its slot and opening to every
// line) left the focus below the fold on a phone, where Chromium kept
// it in place. The page's height is watched for a moment after each
// such focus, and a change in it looks again. Only a Tab counts: a
// script's focus after its own smooth scroll (Proceed to checkout's
// legend) or a tapped field matches :focus-visible too, and an instant
// scroll here would cut the smooth one short.
export const clearFocusUnder = (pane, given) => {
  const bar = given === undefined
    ? document.querySelector(".order-topbar") : given;
  let tabAt = -Infinity;
  let since = -Infinity;
  let tabbed = false;
  const clear = (el, keyed) => {
    if (!el || pane.contains(el) || document.activeElement !== el) return;

    const ceiling = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    const top = pane.getBoundingClientRect().top;
    // The floating pane covers the foot only while it rides there; one
    // the page has scrolled past is above the screen.
    const over = pane.dataset.placement === "floating" && top > ceiling;

    if (!over && !keyed) return;

    const by = clearBy(el.getBoundingClientRect(), {
      floor: over ? Math.min(top, window.innerHeight) : window.innerHeight,
      ceiling,
    });

    if (by > 0) window.scrollBy({ top: by, behavior: "instant" });
  };
  // Captured, so a control that stops the key's propagation still
  // counts.
  const onKey = (e) => {
    if (e.key === "Tab") tabAt = performance.now();
  };
  const onFocus = (e) => {
    since = performance.now();
    tabbed = since - tabAt <= TAB_MS;
    const keyed = tabbed;

    clear(e.target, keyed);
    requestAnimationFrame(() => requestAnimationFrame(
      () => clear(e.target, keyed)
    ));
  };
  // A frame later, as watchList's: a scroll inside the observer's
  // callback is a layout change WebKit warns of as a loop.
  const sizes = new ResizeObserver(() => {
    if (!tabbed || performance.now() - since > SHIFT_MS) return;
    requestAnimationFrame(() => clear(document.activeElement, true));
  });

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocus);
  sizes.observe(document.documentElement);

  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocus);
    sizes.disconnect();
  };
};
