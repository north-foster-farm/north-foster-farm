// A customer changes their own email (#240). The account page asks
// for a link to the new address; only following it moves the account,
// so until then nothing changes and the old address still signs in.
// The move is the CLI's `customers rename` (admin.renameCustomer):
// the record, every order, support messages, farm-news and
// unsubscribe links, the Resend contact and the Square customer. It
// ends the old address's sessions and voids its waiting links, and
// the old address is told.

import { renameCustomer } from "./admin.mjs";
import {
  LINK_WINDOW, LINKS_PER_WINDOW, hit, normalizeEmail, requestLink,
  validEmail,
} from "./auth.mjs";
import { log } from "./log.mjs";
import { sendMail } from "./mail.mjs";
import { getCustomer } from "./records.mjs";
import { mailLinks } from "./site.mjs";
import { emailChanged } from "./templates.mjs";

// Where the account page opens once the move is made.
export const CHANGED_NEXT = "/account/?email=changed#settings";

const refuse = (email) => ({
  ok: false, status: 422, errors: { email },
});

const TOO_MANY = refuse("We've sent a few links already. Use the last " +
  "one, or try again in a few minutes.");

// Voids any change token still waiting for `from` (a stale one from an
// earlier request, or one made moot by the move it's about to send),
// so at most one can ever be followed.
const voidChangeTokens = async (stores, from) => {
  for (const { key } of await stores.auth.list("token/")) {
    const value = await stores.auth.get(key);
    const stale = value && value.changeFrom
      && normalizeEmail(value.changeFrom) === from;

    if (stale) await stores.auth.delete(key);
  }
};

// POST /api/account/email { email }, from a live session. Drafts: the
// customer sees these on the Settings tab.
export const requestEmailChange = async (stores, customer, email, {
  now = new Date(), env = process.env, mail = sendMail, ip = "",
} = {}) => {
  const from = normalizeEmail(customer.email);
  const to = normalizeEmail(email);

  if (!validEmail(to)) {
    return refuse("That email address doesn't look right.");
  }
  if (to === from) return refuse("That's already your email.");
  if (await getCustomer(stores, to)) {
    return refuse("That address already has an account with us. " +
      "Write us and we'll sort it out.");
  }

  const limits = { windowMs: LINK_WINDOW, max: LINKS_PER_WINDOW };

  if ((await hit(stores, `change-rate/${from}`, now.getTime(), limits))
    .limited) {
    return TOO_MANY;
  }
  if (ip && (await hit(stores, `change-ip/${ip}`, now.getTime(), limits))
    .limited) {
    return TOO_MANY;
  }

  await voidChangeTokens(stores, from);

  const sent = await requestLink(stores, { email: to, next: CHANGED_NEXT }, {
    now, env, mail, changeFrom: from,
  });

  if (!sent.ok) return TOO_MANY;

  return { ok: true, email: to };
};

// The followed link: { email, changeFrom } from verifyToken. -> { ok:
// true, email } once moved, or { ok: false, reason } for the sign-in
// page: "change-taken" when the new address has an account of its
// own by now, "change-failed" for anything else.
export const finishEmailChange = async (stores, { email, changeFrom }, {
  now = new Date(), env = process.env, mail = sendMail, square, news,
  fetchImpl,
} = {}) => {
  let report;

  try {
    report = await renameCustomer(stores, changeFrom, email, {
      apply: true, env, now,
      ...(square ? { square } : {}),
      ...(news ? { news } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  } catch (error) {
    const [oldExists, newExists] = await Promise.all([
      getCustomer(stores, changeFrom).then(Boolean),
      getCustomer(stores, email).then(Boolean),
    ]);

    log.warn({
      event: "email.change_refused", reason: error.message,
      from: changeFrom, to: email, oldExists, newExists,
    });

    return {
      ok: false,
      reason: /already has an account/.test(error.message)
        ? "change-taken"
        : "change-failed",
    };
  }

  // The site's records moved; Square or Resend may not have. The
  // farm finishes those by hand, from the log.
  const missed = ["resend", "square"].filter((k) =>
    typeof report[k] === "string" && report[k].startsWith("not reached"));

  log.info({ event: "email.changed", orders: report.orders.length });
  if (missed.length) {
    log.warn({
      event: "email.change_partial", missed,
      detail: missed.map((k) => report[k]),
    });
  }

  try {
    const moved = await getCustomer(stores, report.to);

    await mail({
      to: report.from,
      idempotencyKey: `email-changed-${now.getTime()}`,
      ...emailChanged(report.from, report.to, {
        links: mailLinks(env), marketing: Boolean(moved && moved.marketing),
      }),
    }, { env });
  } catch (error) {
    log.warn({ event: "email.change_notice_failed", error: error.message });
  }

  return { ok: true, email: report.to };
};
