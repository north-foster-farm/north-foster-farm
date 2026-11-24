// Words that change with a move (docs/refactors/cart-view.md).

import {
  MOVE_EASE, MOVE_ID, MOVE_MS, WORD_FRAMES, wordsAt,
} from "./frames.mjs";
import { reduced } from "./style.js";

const put = (el) => {
  if (el.textContent !== el.wantWords) el.textContent = el.wantWords;
};

// Puts the new words in once the old ones have faded to nothing, and
// at the ease's end in any case; a newer ease takes over.
const follow = (el, ease, was) => {
  const look = () => {
    if (el.wordEase !== ease) return;

    const { progress } = ease.effect.getComputedTiming();

    if (wordsAt(progress, was, el.wantWords) !== was) {
      put(el);

      return;
    }
    requestAnimationFrame(look);
  };
  const end = () => {
    if (el.wordEase !== ease) return;
    el.wordEase = null;
    put(el);
  };

  el.wordEase = ease;
  requestAnimationFrame(look);
  ease.finished.then(end, end);
};

// Swaps the words of a control with a move, Hide's or Expand's (#559,
// round 3): the old words fade out with what goes, the new ones are put
// in while nothing shows and fade in with what comes. On the clear,
// Hide became Expand in the frame before anything eased, and then
// "Expand" in one frame at nothing (fix round on 93e80094). Under
// reduced motion, or with no ease, the words change at once. A newer
// change cancels the ease (moveParts), and the newest words go in.
export const swapWords = (el, text, { reduce = reduced() } = {}) => {
  el.wantWords = text;
  if (reduce || typeof el.animate !== "function") {
    el.textContent = text;

    return;
  }
  if (el.wordEase && el.wordEase.playState !== "idle") return;

  const was = el.textContent;
  const ease = el.animate(WORD_FRAMES, {
    duration: MOVE_MS, easing: MOVE_EASE, id: MOVE_ID,
  });

  follow(el, ease, was);
};

// The words a control is showing or on its way to (see swapWords).
export const wordsOf = (el) => el.wantWords ?? el.textContent;
