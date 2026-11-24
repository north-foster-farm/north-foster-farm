// A clock for log-clock.test.mjs (#999): loaded before a test
// file with `--import ./test/fixed-clock.mjs?at=<ISO time>`, it starts
// the clock at that time. `new Date()` and Date.now() then read it,
// moving on in whole seconds as real time passes, and the milliseconds
// stay those of `at`: a line logged at any moment of the run carries a
// timestamp ending as `at` ends. A Date made from a value is untouched.

const at = new URL(import.meta.url).searchParams.get("at");

if (!at || Number.isNaN(Date.parse(at))) {
  throw new Error(`fixed-clock.mjs needs ?at=<ISO time>, not ${at}`);
}

const Real = Date;
const start = Real.now();
const base = Real.parse(at);
const now = () => base + Math.floor((Real.now() - start) / 1000) * 1000;

class FixedDate extends Real {
  constructor(...args) {
    if (args.length) super(...args);
    else super(now());
  }

  static now() {
    return now();
  }
}

globalThis.Date = FixedDate;
