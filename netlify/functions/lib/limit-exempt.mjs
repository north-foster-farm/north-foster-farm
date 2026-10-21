// Off production, a request carrying the staging token (the toolbar's,
// or the e2e suite's own) as X-Staging-Token skips a per-address rate
// limit, so the QA suite and a person testing by hand can share one
// address (docs/staging.md, "The order limit"). Without the header
// staging keeps the limit, so it can still be tested; in production
// the header means nothing. /api/orders and /api/contact use it.

import { deployContext } from "./store.mjs";

export const limitExempt = (req, env = process.env) => {
  const context = deployContext(env);
  const given = req.headers.get("x-staging-token");

  return !!given && !!context && context !== "production" &&
    [env.STAGING_TOKEN, env.E2E_STAGING_TOKEN].includes(given);
};
