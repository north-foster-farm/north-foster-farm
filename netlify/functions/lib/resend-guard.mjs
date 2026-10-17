// Resend is for production alone. Staging reads its mail from the outbox
// driver (MAIL_DRIVER=outbox) and holds no Resend team, key, audience or
// webhook (decided 2026-10-17), so nothing in a staging, preview or
// local run may reach Resend's API, whatever its variables say. Every
// module that calls Resend's API asks here first, and
// test/resend-guard.test.mjs fails when one that does not appears.
//
// An unset context counts as production, as it does for the stores
// (store.mjs), so a deploy that lost SITE_CONTEXT keeps sending.

import { deployContext } from "./store.mjs";

const CONTEXTS = ["production", ""];

export const resendAllowed = (env = process.env) =>
  CONTEXTS.includes(deployContext(env));

export const resendRefusal = (env = process.env) =>
  `Resend is for production only (SITE_CONTEXT=${deployContext(env)}); `
  + "staging and local runs use MAIL_DRIVER=outbox or file";
