// The cart's watch on the keyboard (docs/refactors/cart-view.md).

import { keyboardInset, visibleArea } from "../../lib/cart-scroll.mjs";
import { setProp } from "./style.js";

// The keyboard moves the pane at once: data-keyboard, while it is up
// and for a frame after, sets aside the ease the floating sheet gives
// any other change of where it rests (_cart.scss, #559).
const markKeyboard = (pane, inset, before) => {
  if (inset > 0 || before > 0) {
    cancelAnimationFrame(pane.keyboardTick);
    pane.setAttribute("data-keyboard", "");
  }
};

const writeFacts = (pane, inset, area) => {
  setProp(pane, "--cart-kb", inset);
  setProp(pane, "--cart-gap", area.gap);
  if (inset > 0) setProp(pane, "--cart-vis", area.height);
  else pane.style.removeProperty("--cart-vis");
};

const unmarkLater = (pane, inset) => {
  if (inset !== 0 || !pane.hasAttribute("data-keyboard")) return;
  pane.keyboardTick = requestAnimationFrame(() => {
    pane.keyboardTick = requestAnimationFrame(() => {
      pane.removeAttribute("data-keyboard");
    });
  });
};

// At once, never on a later frame: a phone that draws late (WebKit on
// CI draws every 460 to 700 ms) left the field out of view until that
// frame came, and the frame then undid any scroll of the body made
// since (#635).
const showField = (pane) => {
  const field = document.activeElement;

  if (field && pane.contains(field)
    && field.matches("[data-field='code']")) {
    field.scrollIntoView({ block: "nearest" });
  }
};

// One look at the viewports: the facts written, and the caller told
// when the keyboard's inset changes. `before` is the inset last told.
const syncer = (pane, visual, onInset) => {
  let before = 0;

  return () => {
    const inset = keyboardInset(window.innerHeight, visual);
    const area = visibleArea(window.innerHeight, visual);

    markKeyboard(pane, inset, before);
    writeFacts(pane, inset, area);
    unmarkLater(pane, inset);
    if (inset === before) return;

    const was = before;

    before = inset;
    if (inset > was) showField(pane);
    if (onInset) onInset(inset, was);
  };
};

// Runs `sync` on a resize of either viewport. -> dispose.
const onResize = (visual, sync) => {
  visual.addEventListener("resize", sync);
  window.addEventListener("resize", sync);

  return () => {
    visual.removeEventListener("resize", sync);
    window.removeEventListener("resize", sync);
  };
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
// at once, since Chromium does not do that for a scroller that shrinks
// after the focus.
export const watchKeyboard = (pane, { onInset } = {}) => {
  const visual = window.visualViewport;

  if (!visual) return () => {};

  const sync = syncer(pane, visual, onInset);
  const dispose = onResize(visual, sync);

  sync();

  return dispose;
};
