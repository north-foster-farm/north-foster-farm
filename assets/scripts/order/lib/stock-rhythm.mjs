// When the order page may ask /api/stock (#908, James's rules of
// 2026-11-23): every trigger shares one floor of a check every 15
// seconds, the server's own Square read; and a page with no input for
// five minutes stops checking until the next input, or the tab shown
// again. The clock is Date.now, read at each call.

// One check at most in this long, whatever asks.
export const FLOOR_MS = 15_000;
// No input for this long, and the page stops checking.
export const IDLE_MS = 5 * 60_000;

export class StockRhythm {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.askedAt = -Infinity;
    this.inputAt = now();
  }

  // A check went out.
  asked() {
    this.askedAt = this.now();
  }

  // Whether the last check is inside the floor, so its answer stands.
  get fresh() {
    return this.now() - this.askedAt < FLOOR_MS;
  }

  // Whether the page has gone without input long enough to stop.
  get idle() {
    return this.now() - this.inputAt >= IDLE_MS;
  }

  // Input, or the tab shown again. -> whether the page was idle, so the
  // caller checks at once.
  input() {
    const was = this.idle;

    this.inputAt = this.now();

    return was;
  }
}
