// The busy button (partials/busy-button.html): while a request runs,
// it fades to the egg spinner and its busy word. Every button that
// sends a request is one (#299); test/busy-button.test.mjs holds them
// to it.

// The spinner stays up at least this long, so a quick answer doesn't
// flash it.
const MIN_BUSY_MS = 700;

export const isBusy = (button) => button.dataset.busy === "true";

// A fitted button (.busy-button-fit) eases its width from the face it
// showed to the one it shows. Width won't transition from auto, so it
// is pinned at the start, set to the end, and let go once there, so
// the button goes back to fitting its label.
const fits = new WeakMap();

const fit = (button, change) => {
  const from = button.getBoundingClientRect().width;

  button.style.width = "";
  change();
  const to = button.getBoundingClientRect().width;

  if (from === to) return;
  button.style.width = `${from}px`;
  button.getBoundingClientRect();
  button.style.width = `${to}px`;

  // A later change takes over; only the latest one lets go.
  const turn = (fits.get(button) || 0) + 1;

  fits.set(button, turn);

  const done = (event) => {
    if (event && event.propertyName !== "width") return;
    button.removeEventListener("transitionend", done);
    if (fits.get(button) === turn) button.style.width = "";
  };

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
  else button.addEventListener("transitionend", done);
};

// What a failed request says when it has nothing better.
export const FAILED = "Something went wrong. Please try again.";

// The status line the partial's `error` param writes after the button.
const errorLine = (button) => {
  const line = button.nextElementSibling;

  return line && line.classList.contains("busy-button-error") ? line : null;
};

export const setBusy = (button, on) => {
  const line = errorLine(button);

  // A new try clears the last one's failure, so a second failure with
  // the same words is a change the screen reader announces.
  if (on && line) line.textContent = "";
  if (button.classList.contains("busy-button-fit")) {
    fit(button, () => { button.dataset.busy = on ? "true" : "false"; });
  } else {
    button.dataset.busy = on ? "true" : "false";
  }
  button.setAttribute("aria-disabled", String(on));
  // A screen reader hears the busy word; aria-busy says the button is
  // still working on it (#299).
  if (on) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
  button.querySelector(".busy-button-idle")
    .setAttribute("aria-hidden", String(on));
  button.querySelector(".busy-button-busy")
    .setAttribute("aria-hidden", String(!on));
};

// Idle again after a failed request, saying so on the button's status
// line, if it has one. The line is always in the page, empty until
// now, so writing to it is what the live region announces.
export const failBusy = (button, message = FAILED) => {
  const line = errorLine(button);

  setBusy(button, false);
  if (line) line.textContent = message;
};

// Wires a button that sends a request on a click: busy until `run`
// settles, and a press while busy does nothing.
export const onPress = (button, run) => {
  button.addEventListener("click", () => {
    if (!isBusy(button)) whileBusy(button, run());
  });
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
