// A browser error report (#246), as the /api/health handler keeps it:
// a fixed list of fields, each trimmed, plus the browser's family and
// major version worked out here from the user agent. The full user
// agent is never kept. The fields are fields.mjs's (#258).

import {
  BUILD, CRUMBS, LIMITS, SDK_STATES, SENT, STORED, WHERES, allow, scrub,
} from "../../../assets/scripts/report/fields.mjs";

// Family, then the token whose version is the family's. Order matters:
// Edge, Opera and Samsung's browser all say Chrome too, and every
// browser on iOS says Safari.
const FAMILIES = [
  ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /\bOPR\/(\d+)/],
  ["Samsung Internet", /\bSamsungBrowser\/(\d+)/],
  ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
  ["Chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
  ["Safari", /\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
];

// -> { browser, browserVersion }; "Other" and null when unknown.
export const browserOf = (ua) => {
  const s = String(ua || "");

  for (const [family, pattern] of FAMILIES) {
    const m = s.match(pattern);

    if (m) return { browser: family, browserVersion: Number(m[1]) };
  }

  return { browser: "Other", browserVersion: null };
};

const text = (value, max) => String(value ?? "").slice(0, max) || null;

// Scrubbed whole, then cut, as the reporter does.
const clean = (value, max) => text(scrub(text(value, Infinity)), max);

// A name only if it has a name's shape: anything else is dropped.
const named = (value, shape, max) => {
  const v = text(value, max);

  return v && shape.test(v) ? v : null;
};

const sdkState = (s) => (s && typeof s === "object"
  && SDK_STATES.includes(s.state) ? {
    state: s.state,
    ms: s.ms !== null && Number.isFinite(Number(s.ms))
      ? Math.round(Number(s.ms)) : null,
  } : null);

// The fields of a report, from the beacon's body and the request's
// user agent: fields.mjs's lists, and nothing else (#258). Breadcrumbs
// and SDK states are kept only by their known names, and the message
// and stack are scrubbed again, whatever the browser did.
export const clientDetail = (raw, ua) => {
  const body = allow(raw, SENT);
  const sdks = body.sdks && typeof body.sdks === "object" ? body.sdks : {};

  return allow({
    where: WHERES.includes(body.where) ? body.where : null,
    message: clean(body.message, LIMITS.message),
    stack: clean(body.stack, LIMITS.stack),
    build: named(body.build, BUILD, LIMITS.build),
    page: clean(body.page, LIMITS.page),
    crumbs: (Array.isArray(body.crumbs) ? body.crumbs : [])
      .filter((n) => CRUMBS.includes(n)).slice(-LIMITS.crumbs),
    square: sdkState(sdks.square),
    paypal: sdkState(sdks.paypal),
    ...browserOf(ua),
  }, STORED);
};
