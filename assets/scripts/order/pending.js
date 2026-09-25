// The notice shown while a submission is being retried in the
// background: which attempt this is, how many there will be, a live
// countdown to the next one, and a way to stop.

const qs = (root, selector) => root.querySelector(selector);

const seconds = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));

  return s >= 60
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
    : `${s}s`;
};

export class Pending {
  constructor(el, { max, onRetry, onCancel }) {
    this.el = el;
    this.max = max;
    this.title = qs(el, "[data-pending-title]");
    this.text = qs(el, "[data-pending-text]");
    this.count = qs(el, "[data-pending-count]");
    this.countdown = qs(el, "[data-pending-countdown]");
    this.retryButton = qs(el, "[data-pending-retry]");
    this.cancelButton = qs(el, "[data-pending-cancel]");
    this.ticker = null;

    this.retryButton.addEventListener("click", onRetry);
    this.cancelButton.addEventListener("click", onCancel);
  }

  // An attempt is in flight. `attempt` counts from 1.
  sending(attempt) {
    this.stopTicking();
    this.el.hidden = false;
    this.el.dataset.pendingState = "sending";
    this.title.textContent = attempt === 1
      ? "Placing your order…"
      : "Trying again…";
    this.text.textContent = "Sending your order to our payment system.";
    this.count.textContent = `Attempt ${attempt} of ${this.max}`;
    this.countdown.textContent = "";
    this.retryButton.disabled = true;
  }

  // An attempt failed; the next one is `delayMs` away.
  waiting(attempt, delayMs) {
    const next = attempt + 1;
    const due = Date.now() + delayMs;
    // The countdown sits inside the notice's live region but is marked
    // aria-live="off", and only changes once a second, so a screen
    // reader hears the notice and not every tick.
    const tick = () => {
      const text = `Next try in ${seconds(due - Date.now())}`;

      if (this.countdown.textContent !== text) {
        this.countdown.textContent = text;
      }
    };

    this.el.hidden = false;
    this.el.dataset.pendingState = "waiting";
    this.title.textContent = "We couldn't reach our payment system.";
    this.text.textContent = "Your order is saved on this device and we'll " +
      "keep trying in the background. You can leave this page open, come " +
      "back later, or stop and try again yourself.";
    this.count.textContent = `Attempt ${attempt} of ${this.max} didn't get ` +
      `through. ${next} of ${this.max} is next.`;
    this.retryButton.disabled = false;
    this.stopTicking();
    tick();
    this.ticker = setInterval(tick, 250);
  }

  hide() {
    this.stopTicking();
    this.el.hidden = true;
    delete this.el.dataset.pendingState;
  }

  stopTicking() {
    clearInterval(this.ticker);
    this.ticker = null;
  }

  focus() {
    this.el.scrollIntoView({ block: "center", behavior: "smooth" });
    this.cancelButton.focus({ preventScroll: true });
  }
}
