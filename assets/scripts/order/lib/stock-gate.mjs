// When the order page may sell (#333). Stock is a dependency a
// checkout cannot do without, so a failed check fails closed: the
// first load retries on its own with a backoff, then shuts the page
// with a notice, and a good answer at any later time opens it again.
// A refresh that fails after a good first load keeps the last known
// stock quietly; only the check right before a submission shuts it.

// The waits between the first load's attempts, in milliseconds.
export const FIRST_DELAYS = [2_000, 5_000, 15_000];
// One attempt gives up after this.
export const ATTEMPT_MS = 5_000;
// How often a page that is shut asks again, and how often an open one
// refreshes.
export const SHUT_EVERY = 30_000;
export const OPEN_EVERY = 2 * 60_000;

const wait = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// Runs `attempt` until it answers (not null), pausing for each of
// `delays` after a failure, a throw counting as one. -> the answer,
// or null once the last attempt has failed.
export const withBackoff = async (attempt, {
  delays = FIRST_DELAYS, sleep = wait,
} = {}) => {
  for (let tried = 0; ; tried++) {
    let answer;

    try {
      answer = await attempt(tried);
    } catch {
      answer = null;
    }
    if (answer !== null && answer !== undefined) return answer;
    if (tried >= delays.length) return null;
    await sleep(delays[tried]);
  }
};

export class StockGate {
  constructor() {
    // Whether stock has ever answered; down is the notice showing.
    this.known = false;
    this.down = false;
  }

  // Adding and paying wait while stock is unknown or the notice shows.
  get locked() {
    return !this.known || this.down;
  }

  // How long until the next check.
  get every() {
    return this.down ? SHUT_EVERY : OPEN_EVERY;
  }

  // A good answer. -> whether the notice just came down.
  good() {
    const was = this.down;

    this.known = true;
    this.down = false;

    return was;
  }

  // A failed check; `final` is the one before a submission. Quiet
  // once stock is known, unless it was that final check. -> whether
  // the notice just went up.
  bad({ final = false } = {}) {
    if (this.known && !final) return false;

    const was = this.down;

    this.down = true;

    return !was;
  }
}
