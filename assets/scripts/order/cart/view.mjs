// The cart's view: what touches the viewport, the clock and the
// pane's own motion (#477, docs/cart.md). cart/state.mjs decides the
// state and cart/fold.js writes it; the view feeds the decision and
// animates the result. It writes no height, floor or cap to CSS: the
// stylesheet (_cart.scss) lays the pane out from three raw viewport
// facts (--cart-vis, --cart-gap, --cart-kb) and the top bar's foot
// (--cart-bar), and everything the view measures is measured for the
// decision or the animation alone, at a quiet moment, never written
// back for the layout to read.
//
// This module is the view's one door, re-exports and nothing else
// (docs/refactors/cart-view.md): the cart's modules and the unit
// tests import from here, and the parts live in view/, one concern
// to a module.

// Pure: the queries, lengths, keyframes and rules.
export { COLUMN, SHEET, SHORT } from "./view/queries.mjs";
export { restOf, toPx } from "./view/units.mjs";
export {
  FADE_IN, FADE_OUT, MOVE_ID, MOVE_MS, WORD_FRAMES, fadeFrames, liftShift,
  moveFrames, moves, paneFrames, pillFadeFrames, wordsAt,
} from "./view/frames.mjs";
export { OWN_MS, ownScroll } from "./view/own-scroll.mjs";
export { moreShown } from "./view/more.mjs";

// The watchers, motions and cues, which touch the page.
export { watchKeyboard } from "./view/keyboard.js";
export { watchPlacement } from "./view/placement.js";
export { watchScroll } from "./view/scroll.js";
export { animateFold } from "./view/fold.js";
export { shutShare } from "./view/share.js";
export { revealLine, watchList } from "./view/list.js";
export { pulsePill, ringCart, showAdded } from "./view/cues.js";
export { teach } from "./view/teach.js";
export { clearFocusUnder, focusAfterScroll } from "./view/focus.js";
export { swapWords, wordsOf } from "./view/words.js";
export { moveParts, moving } from "./view/move.js";
