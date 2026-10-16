// A browser error report (#246), as the /api/health handler keeps it:
// a fixed list of fields, each trimmed, plus the browser's family and
// major version worked out here from the user agent. The full user
// agent is never kept.

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

const names = (list, max) => (Array.isArray(list) ? list : [])
  .slice(-max).map((n) => String(n).slice(0, 40));

const sdkState = (s) => (s && typeof s === "object" ? {
  state: text(s.state, 20),
  ms: Number.isFinite(Number(s.ms)) && s.ms !== null
    ? Math.round(Number(s.ms)) : null,
} : null);

// The fields of a report, from the beacon's body and the request's
// user agent. Anything else in the body is dropped.
export const clientDetail = (body, ua) => {
  const sdks = body && typeof body.sdks === "object" && body.sdks
    ? body.sdks : {};

  return {
    where: text(body.where, 40),
    message: text(body.message, 300),
    stack: text(body.stack, 2000),
    build: text(body.build, 40),
    page: text(body.page, 200),
    crumbs: names(body.crumbs, 20),
    square: sdkState(sdks.square),
    paypal: sdkState(sdks.paypal),
    ...browserOf(ua),
  };
};
