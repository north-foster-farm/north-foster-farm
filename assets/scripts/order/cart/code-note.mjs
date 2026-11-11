// The line under the discount code (#532): what the form made of the
// code Apply sent. An accepted code's line and a refused one's each
// stay NOTE_STAY, then fade over NOTE_FADE and go; any other line
// stays until the next one. No DOM: `show` draws the line, with
// `fading` once it starts to go, and `clear` empties the field, which
// only an accepted code does. A refused code stays in the field for
// the next open.

// How long the line stays before it fades (4 s, a draft for James:
// the accepted line stayed 15 s before #532 asked for a short time).
export const NOTE_STAY = 4000;

// How long the fade takes; the stylesheet's own is a little shorter
// (_cart.scss .order-cart-code-note).
export const NOTE_FADE = 700;

export const codeNote = ({
  stay = NOTE_STAY, fade = NOTE_FADE,
  show = () => {}, clear = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) => {
  let timer = null;

  const stop = () => {
    clearTimer(timer);
    timer = null;
  };

  return {
    // `text` and `tone` for the line ("good" for an accepted code);
    // `accepted` or `refused` for an outcome of Apply, whose line goes.
    result({ text = "", tone = "", accepted = false, refused = false } = {}) {
      stop();
      show({ text, tone, fading: false });
      if (accepted) clear();
      if (!text || !(accepted || refused)) return;

      timer = setTimer(() => {
        show({ text, tone, fading: true });
        timer = setTimer(() => {
          timer = null;
          show({ text: "", tone: "", fading: false });
        }, fade);
      }, stay);
    },
  };
};
