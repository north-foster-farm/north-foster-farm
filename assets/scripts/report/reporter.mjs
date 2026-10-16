// The order page's error reporter (#246), installed by
// assets/scripts/report.js. It hooks the window's errors and
// unhandled rejections, and gives the bundle
//
//   window.nffReport(kind, { where, error })
//       kind "error" (logged) or "payment.unavailable" (an alert);
//       where, a fixed name for the place that failed
//   window.nffReport.crumb(name)    one step the customer took
//   window.nffReport.sdk(name, state)
//       "square" or "paypal": "loading", "ready" or "failed"
//
// A report goes to POST /api/health by sendBeacon, so it survives the
// tab closing. Its fields are fields.mjs's and no others (#258):
// what failed, the page's path, the build, the last steps by name
// and each SDK's state, with emails and phone numbers scrubbed from
// the message and the stack. Nothing here may throw: every path is
// wrapped, and a report that cannot be sent is dropped.
//
// `g` is the global scope: the browser's, or a test's stand-in.

import {
  CRUMBS, KINDS, LIMITS, SDKS, SDK_STATES, SENT, WHERES, allow, scrub,
} from "./fields.mjs";

const MAX_REPORTS = 5;
const MAX_FRAMES = 10;

const text = (value, max) => {
  try {
    return String(value === undefined || value === null ? "" : value)
      .slice(0, max);
  } catch {
    return "";
  }
};

// Scrubbed whole, then cut: a cut first could leave half an address
// the scrubber no longer recognises.
const clean = (value, max) => scrub(text(value, Infinity)).slice(0, max);

// The first frames of a stack, which is where the cause is.
const trimStack = (stack) => clean(stack, Infinity).split("\n")
  .slice(0, MAX_FRAMES + 1).join("\n").slice(0, LIMITS.stack);

export const install = (g) => {
  const crumbs = [];
  const sdks = {};
  const sent = new Set();
  let build = "";

  try {
    const self = g.document.currentScript;

    build = (self && self.dataset.build) || "";
  } catch {
    // No build id: the report says so.
  }

  const now = () => {
    try {
      return Math.round(g.performance.now());
    } catch {
      return null;
    }
  };

  const send = (body) => {
    const data = JSON.stringify(body);

    try {
      if (g.navigator.sendBeacon && g.navigator.sendBeacon("/api/health",
        new g.Blob([data], { type: "application/json" }))) {
        return;
      }
    } catch {
      // Fall through to fetch.
    }
    try {
      g.fetch("/api/health", {
        method: "POST", body: data, keepalive: true,
        headers: { "Content-Type": "application/json" },
      }).catch(() => {});
    } catch {
      // Dropped.
    }
  };

  const report = (kind, options) => {
    try {
      const { where, error } = options || {};

      if (!KINDS.includes(kind) || sent.size >= MAX_REPORTS) return;

      const message = clean(error && error.message !== undefined
        ? error.message : error, LIMITS.message);
      const key = `${kind} ${where} ${message}`;

      if (sent.has(key)) return;
      sent.add(key);
      send(allow({
        kind,
        where: WHERES.includes(where) ? where : null,
        message,
        stack: trimStack(error && error.stack),
        build: text(build, LIMITS.build),
        page: text(g.location.pathname, LIMITS.page),
        crumbs: crumbs.slice(-LIMITS.crumbs),
        sdks: Object.fromEntries(Object.entries(sdks)
          .map(([name, s]) => [name, { state: s.state, ms: s.ms }])),
      }, SENT));
    } catch {
      // Never the customer's problem.
    }
  };

  report.crumb = (name) => {
    try {
      if (!CRUMBS.includes(name)) return;
      crumbs.push(name);
      if (crumbs.length > LIMITS.crumbs) crumbs.shift();
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
    g.window.nffReport = report;
    report.crumb("page.load");

    g.window.addEventListener("error", (e) => {
      // A script from another origin says only "Script error." with
      // nothing to act on: Square's and PayPal's own faults are told
      // through the bundle's report() instead.
      if (!e || (!e.error && /^Script error\.?$/.test(e.message || ""))) {
        return;
      }
      report("error", { where: "window.error", error: e.error || e.message });
    });
    g.window.addEventListener("unhandledrejection", (e) => {
      report("error", { where: "window.rejection", error: e && e.reason });
    });
  } catch {
    // A browser this old reports nothing.
  }

  return report;
};
