// A control that asks before it acts (#531): the first press arms it
// and says so, a second press within `wait` milliseconds acts, and a
// press after that arms it again. Clear cart uses it, so one stray tap
// never empties the cart. No DOM: the caller draws each state in
// `onArm` and `onDisarm`, and `onConfirm` acts.

// How long the armed state waits for its second press.
export const CONFIRM_WAIT = 4000;

export const twoStep = ({
  wait = CONFIRM_WAIT, onArm = () => {}, onDisarm = () => {},
  onConfirm = () => {},
} = {}) => {
  let timer = null;

  const disarm = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    onDisarm();
  };

  return {
    // Whether the next press acts.
    get armed() {
      return timer !== null;
    },

    press() {
      if (timer !== null) {
        disarm();
        onConfirm();

        return true;
      }
      timer = setTimeout(() => {
        timer = null;
        onDisarm();
      }, wait);
      onArm();

      return false;
    },

    // Back to the first press at once: Escape, or the control leaving.
    reset: disarm,
  };
};
