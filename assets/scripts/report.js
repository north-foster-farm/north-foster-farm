// The order page's error reporter (#246). Built on its own and loaded
// in <head>, before the order bundle, so a crash in the bundle is
// still caught. It hooks the window's errors and unhandled
// rejections, and gives the bundle
//
//   window.nffReport(kind, { where, error })
//       kind "error" (logged) or "payment.unavailable" (an alert);
//       where, a fixed name for the place that failed
//   window.nffReport.crumb(name)    one step the customer took
//   window.nffReport.sdk(name, state)
//       "square" or "paypal": "loading", "ready" or "failed"
//
// A report goes to POST /api/health by sendBeacon, so it survives the
// tab closing. It carries what failed, the page's path, the build,
// the last steps by name and each SDK's state, never a value from the
// form; the server works out the browser from the user agent. Nothing
// here may throw: every path is wrapped, and a report that cannot be
// sent is dropped.

const KINDS = ["error", "payment.unavailable"];

// The steps a breadcrumb may name. Anything else is dropped.
const CRUMBS = [
  "page.load", "pay.load", "config.ok", "config.failed",
  "square.ready", "square.load_failed", "card.ready", "card.attach_failed",
  "wallets.ready", "paypal.ready", "paypal.load_failed", "venmo.ready",
  "venmo.render_failed", "pay.press", "pay.ok", "pay.failed",
  "venmo.approve", "venmo.cancel",
];
const SDKS = ["square", "paypal"];
const SDK_STATES = ["loading", "ready", "failed"];

const MAX_CRUMBS = 20;
const MAX_REPORTS = 5;
const MAX_FRAMES = 10;

const crumbs = [];
const sdks = {};
const sent = new Set();
let build = "";

try {
  const self = document.currentScript;

  build = (self && self.dataset.build) || "";
} catch {
  // No build id: the report says so.
}

const now = () => {
  try {
    return Math.round(performance.now());
  } catch {
    return null;
  }
};

const text = (value, max) => {
  try {
    return String(value === undefined || value === null ? "" : value)
      .slice(0, max);
  } catch {
    return "";
  }
};

// The first frames of a stack, which is where the cause is.
const trimStack = (stack) => text(stack, 4000).split("\n")
  .slice(0, MAX_FRAMES + 1).join("\n").slice(0, 2000);

const send = (body) => {
  const data = JSON.stringify(body);

  try {
    if (navigator.sendBeacon && navigator.sendBeacon("/api/health",
      new Blob([data], { type: "application/json" }))) {
      return;
    }
  } catch {
    // Fall through to fetch.
  }
  try {
    fetch("/api/health", {
      method: "POST", body: data, keepalive: true,
      headers: { "Content-Type": "application/json" },
    }).catch(() => {});
  } catch {
    // Dropped.
  }
};

const report = (kind, { where, error } = {}) => {
  try {
    if (!KINDS.includes(kind) || sent.size >= MAX_REPORTS) return;

    const message = text(error && error.message !== undefined
      ? error.message : error, 300);
    const key = `${kind} ${where} ${message}`;

    if (sent.has(key)) return;
    sent.add(key);
    send({
      kind,
      where: text(where, 40),
      message,
      stack: trimStack(error && error.stack),
      build,
      page: text(location.pathname, 200),
      crumbs: crumbs.slice(-MAX_CRUMBS),
      sdks: Object.fromEntries(Object.entries(sdks)
        .map(([name, s]) => [name, { state: s.state, ms: s.ms }])),
    });
  } catch {
    // Never the customer's problem.
  }
};

report.crumb = (name) => {
  try {
    if (!CRUMBS.includes(name)) return;
    crumbs.push(name);
    if (crumbs.length > MAX_CRUMBS) crumbs.shift();
  } catch {
    // As above.
  }
};

// The time from "loading" to the state it ended in, in milliseconds.
report.sdk = (name, state) => {
  try {
    if (!SDKS.includes(name) || !SDK_STATES.includes(state)) return;

    const t = now();
    const current = sdks[name];

    if (state === "loading" || !current) {
      sdks[name] = { state, startedAt: t, ms: null };
    } else {
      sdks[name] = {
        ...current, state, ms: t === null || current.startedAt === null
          ? null : t - current.startedAt,
      };
    }
  } catch {
    // As above.
  }
};

try {
  window.nffReport = report;
  report.crumb("page.load");

  window.addEventListener("error", (e) => {
    // A script from another origin says only "Script error." with
    // nothing to act on: Square's and PayPal's own faults are told
    // through the bundle's report() instead.
    if (!e || (!e.error && /^Script error\.?$/.test(e.message || ""))) {
      return;
    }
    report("error", { where: "window.error", error: e.error || e.message });
  });
  window.addEventListener("unhandledrejection", (e) => {
    report("error", { where: "window.rejection", error: e && e.reason });
  });
} catch {
  // A browser this old reports nothing.
}
