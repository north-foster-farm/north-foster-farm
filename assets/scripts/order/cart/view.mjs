// The cart's view: what touches the viewport, the clock and the
// pane's own motion (#477, docs/cart.md). cart/state.mjs decides the
// state and cart/cart.js writes it; this module feeds the decision and
// animates the result. It writes no height, floor or cap to CSS: the
// stylesheet (_cart.scss) lays the pane out from three raw viewport
// facts (--cart-vis, --cart-gap, --cart-kb) and the top bar's foot
// (--cart-bar), and everything measured here is measured for the
// decision or the animation alone, at a quiet moment, never written
// back for the layout to read.

import { COLUMN, SHEET, SHORT } from "./view/queries.mjs";
import { restOf, toPx } from "./view/units.mjs";
import {
  FADE_IN, FADE_OUT, MOVE_ID, MOVE_MS, WORD_FRAMES, fadeFrames, liftShift,
  moveFrames, moves, paneFrames, pillFadeFrames, wordsAt,
} from "./view/frames.mjs";
import { OWN_MS, ownScroll } from "./view/own-scroll.mjs";
import { moreShown } from "./view/more.mjs";
import { watchKeyboard } from "./view/keyboard.js";
import { watchPlacement } from "./view/placement.js";
import { watchScroll } from "./view/scroll.js";
import { animateFold } from "./view/fold.js";
import { shutShare } from "./view/share.js";
import { revealLine, watchList } from "./view/list.js";
import { pulsePill, ringCart, showAdded } from "./view/cues.js";
import { teach } from "./view/teach.js";
import { clearFocusUnder, focusAfterScroll } from "./view/focus.js";
import { swapWords, wordsOf } from "./view/words.js";
import { moveParts, moving } from "./view/move.js";

// The parts that have moved live in view/ (docs/refactors/cart-view.md);
// this module is still the one door to them.
export {
  COLUMN, SHORT, SHEET, toPx, restOf, OWN_MS, ownScroll, MOVE_MS, MOVE_ID,
  FADE_OUT, FADE_IN, moveFrames, fadeFrames, paneFrames, liftShift,
  pillFadeFrames, moves, WORD_FRAMES, wordsAt, moreShown, watchKeyboard,
  watchPlacement, watchScroll, animateFold, shutShare, watchList,
  revealLine, pulsePill, ringCart, showAdded, teach, clearFocusUnder,
  focusAfterScroll, swapWords, wordsOf, moveParts, moving,
};
