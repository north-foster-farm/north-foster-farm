// Joining a buying group from its sign-up page (#495, part 4). The
// group's QR code is a link to /join/?t=<join token>. The page asks
// for the email address, first and last name, and an unticked Farm
// News box, and sends a sign-in link through the site's own template
// (groupJoinLink). Following it signs in, joins the group and lands on
// Account, Membership. A customer signed in already joins at once and
// is asked for nothing.
//
// What the link carries is in the auth store's token record, never the
// join token itself: the group's key and a hash of the token, so a
// link followed after the host replaced the QR code signs in and joins
// nothing. Typed names fill only a record that has none, so a stranger
// typing someone else's address changes nothing of theirs: the link
// goes to that address, and nothing happens until it is followed.

import { createHash } from "node:crypto";

import {
  fieldError,
} from "../../../assets/scripts/utils/field-errors.mjs";
import { normalizeEmail, requestLink, validEmail } from "./auth.mjs";
import { now as clock } from "./clock.mjs";
import {
  findGroupByToken, getGroupRecord, groupOf, joinGroup, memberKeyOf,
  namedGroup,
} from "./groups.mjs";
import { sendMail } from "./mail.mjs";
import { joined, optIn, welcome } from "./news.mjs";
import { getCustomer, saveCustomer } from "./records.mjs";

// Where a join lands: the Membership tab, with the banner.
export const JOINED_PATH = "/account/?joined=1#membership";
export const ACCOUNT_PATH = "/account/";

// The join log's path for the sign-up page: the QR code is the only
// place its link is given out today.
export const VIA = "qr";

// Draft wording for James. Every link that fails says the same.
export const INVALID_LINK = "That link to join a group isn't valid. Ask " +
  "the group's host for a new one.";
export const ELSEWHERE = "Your account is already in another group, so " +
  "this one can't be added.";

const hash = (value) => createHash("sha256").update(String(value))
  .digest("hex");

const clean = (value) => String(value || "").trim().slice(0, 80);

// -> { ok, group } for a token in force, the group named as members
// see it, or { ok: false }.
export const checkToken = async (stores, token) => {
  const group = await findGroupByToken(stores, token);

  return group
    ? { ok: true, group: await namedGroup(stores, group) }
    : { ok: false };
};

// The sign-up form: validates and mails the link. Names are needed
// unless the address already has them; the page can't know that, so
// it asks, and the record keeps its own. -> { ok } or { ok: false,
// errors } or { ok: false, invalid } for a dead token.
export const requestJoin = async (stores, body, {
  now = clock(), env = process.env, mail = sendMail,
} = {}) => {
  const checked = await checkToken(stores, body.token);

  if (!checked.ok) return { ok: false, invalid: true };

  const email = normalizeEmail(body.email);
  const firstName = clean(body.firstName);
  const lastName = clean(body.lastName);
  const errors = {};

  // The order form's words for the same fields.
  if (!validEmail(email)) errors.email = fieldError("email", body.email);
  if (!firstName) errors.firstName = "Please enter your first name.";
  if (!lastName) errors.lastName = "Please enter your last name.";
  if (Object.keys(errors).length) return { ok: false, errors };

  const sent = await requestLink(stores, {
    email, next: JOINED_PATH,
  }, {
    now, env, mail,
    join: {
      name: checked.group.name,
      record: {
        group: checked.group.key, tokenHash: hash(body.token), via: VIA,
        firstName, lastName, news: body.news === true,
      },
    },
  });

  // Too many links for the address: the earlier one still works, and
  // the page says the same either way.
  return { ok: sent.ok || sent.reason === "rate" };
};

// The names on a record that has none, and Farm News if ticked.
const fillIn = async (stores, email, join, { now, env, mail }) => {
  const customer = await getCustomer(stores, email);

  if (customer && !customer.firstName && !customer.lastName
    && !customer.name && (join.firstName || join.lastName)) {
    await saveCustomer(stores, {
      ...customer,
      firstName: join.firstName,
      lastName: join.lastName,
      name: [join.firstName, join.lastName].filter(Boolean).join(" "),
    });
  }
  if (join.news) {
    const before = await getCustomer(stores, email);
    const after = await optIn(stores, email, {
      firstName: join.firstName, lastName: join.lastName, source: "signup",
      detail: "The group sign-up page",
    }, now);

    if (joined(before, after)) await welcome(stores, after, { env, mail, now });
  }
};

// From the link: the group's key and the hash of the token it was sent
// with, which must still be the one in force. -> the group, or null.
const linkedGroup = async (stores, key, tokenHash) => {
  const stored = key && tokenHash ? await getGroupRecord(stores, key) : null;

  return stored && stored.joinToken && hash(stored.joinToken) === tokenHash
    ? groupOf(key)
    : null;
};

// Joins the group for a customer signed in, from the page or from the
// link. A token replaced since joins nothing. -> { ok, path, group?,
// elsewhere? } where `path` is where the browser goes next.
export const joinNow = async (stores, email, {
  token = null, tokenHash = null, group: key = null, via = VIA,
}, { now = clock() } = {}) => {
  const target = token
    ? await findGroupByToken(stores, token)
    : await linkedGroup(stores, key, tokenHash);

  if (!target) return { ok: false, invalid: true, path: ACCOUNT_PATH };

  const own = memberKeyOf(await getCustomer(stores, email));

  // The join refuses another group's member and logs it (edge 2).
  await joinGroup(stores, email, target.key, { now, via });

  return own && own !== target.key
    ? { ok: false, elsewhere: true, path: ACCOUNT_PATH }
    : { ok: true, group: target.key, path: JOINED_PATH };
};

// Following the link: the names, Farm News, then the group.
export const finishJoin = async (stores, email, join, {
  now = clock(), env = process.env, mail = sendMail,
} = {}) => {
  await fillIn(stores, email, join, { now, env, mail });

  return joinNow(stores, email, {
    group: join.group, tokenHash: join.tokenHash, via: join.via || VIA,
  }, { now });
};
