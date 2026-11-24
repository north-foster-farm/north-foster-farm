// The overflow spec's page walks load 29 pages each, eight walks in a
// row. At full speed against staging, Netlify's bot challenge answered
// them 8 to 11 loads into each walk (full run 44396830525; #653).
// Netlify documents no setting for the challenge and no exception a
// GitHub runner could match, so a walk against staging slows to the
// rest of the suite's pace, which has never met it. A local build has
// no challenge and goes at full speed.

// The wait between two page loads of a walk against staging. Inferred
// from one run's timings (#653): the whole suite, about one navigation
// a second overall, never met the challenge.
export const PACE_MS = 1_000;

// Whether a base URL is a local server, as playwright.config.mjs
// tells one from a deploy.
const isLocal = (baseURL) => {
  const host = new URL(baseURL).hostname;

  return host === "localhost" || host === "127.0.0.1";
};

// -> how long to wait between page loads against `baseURL`.
export const paceMs = (baseURL) => (isLocal(baseURL) ? 0 : PACE_MS);

// Waits that long; answers at once against a local build.
export const pace = async (baseURL) => {
  const ms = paceMs(baseURL);

  if (ms) await new Promise((r) => { setTimeout(r, ms); });
};
