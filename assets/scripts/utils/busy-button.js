// The busy button (partials/busy-button.html): while a request runs,
// it fades to the egg spinner and its busy word.

// The spinner stays up at least this long, so a quick answer doesn't
// flash it.
const MIN_BUSY_MS = 700;

export const isBusy = (button) => button.dataset.busy === "true";

export const setBusy = (button, on) => {
  button.dataset.busy = on ? "true" : "false";
  button.setAttribute("aria-disabled", String(on));
  button.querySelector(".busy-button-idle")
    .setAttribute("aria-hidden", String(on));
  button.querySelector(".busy-button-busy")
    .setAttribute("aria-hidden", String(!on));
};

// Runs the request with the button busy and resolves with its result,
// no sooner than the minimum.
export const whileBusy = async (button, request) => {
  setBusy(button, true);
  try {
    const [result] = await Promise.all([
      request,
      new Promise((resolve) => setTimeout(resolve, MIN_BUSY_MS)),
    ]);

    return result;
  } finally {
    setBusy(button, false);
  }
};
