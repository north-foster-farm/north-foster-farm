// Invite links (#718): a single-use link the farm makes for one perk
// (#514) and sends by hand, by text or email. The site sends none. The
// person who follows it signs up with their own email address through
// the usual magic link, and the perk then goes on that account, new or
// existing. The link is the proof: a typed address grants nothing
// (#521), and the link works once, for 14 days.
//
// Store layout (the `invites` store):
//   invite/<id>         { id, perk, end, note, square, owner, tokenHash,
//                         createdAt, createdBy, expires, usedAt?,
//                         usedBy?, revokedAt?, revokedBy? }
//   token/<sha256(t)>   { id }   the link's token, found by its hash
//
// The token itself is stored nowhere: the link holds it, and the
// record its hash. `note` is the farm's own reminder of who the invite
// is for, never shown to the customer and never logged. `usedBy` is
// the address it went to, masked (#496), so the list says which
// account took it without keeping the address twice. `end` is the
// perk's last day, as `perks add --end`; the invite's own life is
// `expires`. Each change is logged (#497): making, using, revoking.
// Expiry is a date passing, not a write, so it logs nothing.

import { createHash, randomBytes } from "node:crypto";

import {
  DAY, PERKS, PERK_TYPES,
} from "../../../assets/scripts/order/lib/perks.mjs";
import { today } from "../../../assets/scripts/order/lib/zoned.mjs";
import { now as clock } from "./clock.mjs";
import { log } from "./log.mjs";
import { maskEmail } from "./mask.mjs";
import { addPerk } from "./perks.mjs";
import { getCustomer, saveCustomer } from "./records.mjs";
import { siteUrl } from "./site.mjs";
import { setCustomerEmail } from "./square.mjs";
import terms from "./terms.mjs";

export const INVITE_DAYS = 14;
export const INVITE_TTL = INVITE_DAYS * 24 * 60 * 60_000;
export const INVITE_PATH = "/invite/";
// Where following the link lands: the account page names the perks.
export const INVITED_PATH = "/account/";

// Draft wording for James. Every dead link says the same: used,
// expired, revoked or never made.
export const INVALID_INVITE = "That invite link isn't valid. Ask the " +
  "farm for a new one.";

const hash = (value) => createHash("sha256").update(String(value))
  .digest("hex");

const inviteKey = (id) => `invite/${id}`;
const tokenKey = (token) => `token/${hash(token)}`;

const dayOf = (now) => today(now, terms.timeZone);

// -> "open", "used", "revoked" or "expired" at `now`.
export const inviteState = (invite, now = clock()) => {
  if (invite.usedAt) return "used";
  if (invite.revokedAt) return "revoked";

  return now.getTime() > invite.expires ? "expired" : "open";
};

const checkPerk = (perk, owner) => {
  if (!PERKS[perk]) {
    throw new Error(`Unknown perk "${perk}". Known: ${
      PERK_TYPES.join(", ")}.`);
  }
  if (PERKS[perk].owner && !owner) {
    throw new Error(`Only James sets the ${perk} perk: add --owner if ` +
      "you are James.");
  }
};

const checkEnd = (end, now) => {
  if (!end) return;
  if (!(DAY.test(end) && !Number.isNaN(Date.parse(end)))) {
    throw new Error("--end is a date, YYYY-MM-DD.");
  }
  if (end < dayOf(now)) throw new Error("--end is in the past.");
};

const SQUARE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Makes an invite. `square` names the person's Square customer, so
// their account and their Square history join up when it is used.
// `owner` says James himself made it, which the family perk needs.
// -> { id, url, expires }. The url is the only place the token is.
export const addInvite = async (stores, perk, {
  end = null, note = null, square = null, owner = false, by = null,
  now = clock(), env = process.env,
} = {}) => {
  checkPerk(perk, owner);
  checkEnd(end, now);
  if (square && !SQUARE_ID.test(square)) {
    throw new Error("--square is a Square customer id.");
  }

  const id = `inv-${randomBytes(6).toString("hex")}`;
  const token = randomBytes(32).toString("base64url");
  const invite = {
    id, perk, end: end || null,
    note: note ? String(note).slice(0, 200) : null,
    square: square || null, owner: !!owner,
    tokenHash: hash(token),
    createdAt: now.toISOString(), createdBy: by || "cli",
    expires: now.getTime() + INVITE_TTL,
  };

  await stores.invites.set(inviteKey(id), invite);
  await stores.invites.set(tokenKey(token), { id });

  log.info({
    event: "invite.added", by: invite.createdBy, invite: id, perk,
    end: invite.end, expires: new Date(invite.expires).toISOString(),
    square: !!invite.square, before: null, after: "open",
  });

  return {
    id, url: `${siteUrl(env)}${INVITE_PATH}?t=${token}`,
    expires: new Date(invite.expires).toISOString(),
  };
};

// The invite a link's token names, whatever its state, or null.
const byToken = async (stores, token) => {
  if (!token || typeof token !== "string" || token.length > 200) return null;

  const found = await stores.invites.get(tokenKey(token));

  return found ? stores.invites.get(inviteKey(found.id)) : null;
};

// For the invite page: -> { ok, invite } for a link still open at
// `now`, or { ok: false }. The invite is the record, for the server's
// use; the page is told only the perk.
export const checkInvite = async (stores, token, { now = clock() } = {}) => {
  const invite = await byToken(stores, token);

  return invite && inviteState(invite, now) === "open"
    ? { ok: true, invite }
    : { ok: false };
};

// What the sign-in link carries, in the auth store's token record: the
// invite's id and the hash of the token it was asked for with, never
// the token itself.
export const linkRecord = (invite) => ({
  id: invite.id, tokenHash: invite.tokenHash,
});

// Every invite, newest first, with its state at `now`. Read only; the
// note is the farm's, so it is listed.
export const listInvites = async (stores, { now = clock() } = {}) => {
  const keys = await stores.invites.list("invite/");
  const rows = [];

  for (const { key } of keys) {
    const invite = await stores.invites.get(key);

    if (invite) rows.push({ ...invite, state: inviteState(invite, now) });
  }

  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};

// Ends an invite now. An unknown id, or one already used or revoked,
// is refused. -> the invite as it now stands.
export const revokeInvite = async (stores, id, {
  by = null, now = clock(),
} = {}) => {
  const key = inviteKey(String(id || ""));
  const invite = /^inv-[0-9a-f]{12}$/.test(String(id || ""))
    ? await stores.invites.get(key)
    : null;

  if (!invite) throw new Error(`No invite ${id}.`);

  const before = inviteState(invite, now);

  if (before === "used" || before === "revoked") {
    throw new Error(`Invite ${id} is already ${before}.`);
  }

  const saved = {
    ...invite, revokedAt: now.toISOString(), revokedBy: by || "cli",
  };

  await stores.invites.set(key, saved);
  log.info({
    event: "invite.revoked", by: saved.revokedBy, invite: id,
    perk: invite.perk, before, after: "revoked",
  });

  return { ...saved, state: "revoked" };
};

// Marks the invite used by `email`, if it is still open and the link
// was asked for with its token. Of two links followed at once, one
// wins. -> the invite as it was, or null when it is no longer open.
const useUp = async (stores, link, email, now) => {
  const key = inviteKey(String(link.id || ""));

  for (let tries = 0; tries < 3; tries += 1) {
    const tagged = await stores.invites.getTagged(key);
    const invite = tagged && tagged.value;

    if (!invite || invite.tokenHash !== link.tokenHash
      || inviteState(invite, now) !== "open") return null;

    const used = {
      ...invite, usedAt: now.toISOString(), usedBy: maskEmail(email),
    };

    if (await stores.invites.swap(key, used, tagged.etag)) return invite;
  }

  return null;
};

// The person's Square customer gets the account's address, so the
// site's orders find that profile by it and the account holds its id.
// A failure never stops the sign-in: the farm sees it in the log.
// -> "linked", "failed" or null with no Square customer named.
const linkSquare = async (stores, invite, email, { env, fetchImpl }) => {
  if (!invite.square) return null;

  try {
    await setCustomerEmail(invite.square, email, { env, fetchImpl });

    const customer = await getCustomer(stores, email);

    await saveCustomer(stores, {
      ...customer, squareCustomerId: invite.square,
    });

    return "linked";
  } catch (error) {
    log.warn({
      event: "invite.square-failed", by: "customer", invite: invite.id,
      record: maskEmail(email), error: error.code || error.message,
    });

    return "failed";
  }
};

// Following the sign-in link the invite page mailed: the perk goes on
// the account if the invite is still open at this moment, and the
// invite is used up. -> { ok, perk? }. An invite that died since the
// link was asked for grants nothing, and the sign-in goes on.
export const finishInvite = async (stores, email, link, {
  now = clock(), env = process.env, fetchImpl,
} = {}) => {
  const invite = link ? await useUp(stores, link, email, now) : null;

  if (!invite) return { ok: false };

  let granted = true;

  try {
    await addPerk(stores, email, invite.perk, {
      end: invite.end, by: `invite ${invite.id}`, owner: invite.owner, now,
    });
  } catch (error) {
    // Already held, or an end that has passed: the invite is still
    // spent, on the person it was sent to.
    granted = false;
    log.warn({
      event: "invite.perk-refused", by: "customer", invite: invite.id,
      record: maskEmail(email), error: error.message,
    });
  }

  const square = await linkSquare(stores, invite, email, { env, fetchImpl });

  log.info({
    event: "invite.used", by: "customer", invite: invite.id,
    record: maskEmail(email), perk: invite.perk, granted,
    ...(square ? { square } : {}), before: "open", after: "used",
  });

  return { ok: true, perk: granted ? invite.perk : null };
};
