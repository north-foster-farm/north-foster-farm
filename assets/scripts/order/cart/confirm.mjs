// A control that asks before it acts (#531): the first press arms it
// and says so, a second press within `wait` milliseconds acts, and a
// press after that arms it again. A press less than `guard`
// milliseconds after arming is ignored, so a double tap or a bounced
// click is still one press. Clear cart uses it, so one stray tap never
// empties the cart. No DOM: the caller draws each state in `onArm` and
// `onDisarm`, and `onConfirm` acts.

// How long the armed state waits for its second press (6 s, James may
// change it).
export const CONFIRM_WAIT = 6000;

// How soon after arming a second press counts.
export const CONFIRM_GUARD = 400;

export const twoStep = ({
  wait = CONFIRM_WAIT, guard = CONFIRM_GUARD, now = () => Date.now(),
  onArm = () => {}, onDisarm = () => {}, onConfirm = () => {},
} = {}) => {
  let timer = null;
  let armedAt = 0;

  const disarm = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    onDisarm();
  };

  return {
    // Whether the control is asking for its second press.
    get armed() {
      return timer !== null;
    },

    // Acts and returns true on a confirming press; otherwise false.
    press() {
      if (timer !== null) {
        if (now() - armedAt < guard) return false;
        disarm();
        onConfirm();

        return true;
      }
      armedAt = now();
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
