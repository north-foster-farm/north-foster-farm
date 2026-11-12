// Member codes (#131): each member of a buying group gets an opaque,
// stable ID that the Membership tab shows as text and as a QR code, a
// key tag carries, and the Square Point of Sale app finds the customer
// by at the stand, where it is the `reference_id` of their Square
// profile.
//
// An ID is NFM- and eight characters of the pass alphabet (no 0, O, 1,
// I or L, so it reads out over the counter), never an email address or
// a name: the code is scanned in public and printed. It is not a
// secret either, since a scan only says who the customer is. 31^8 is
// about 850 billion, so two members meeting on one is rare, and the
// create-only claim on `member-id/<id>` (lib/records.mjs) settles it
// when it happens.
//
// The ID stays with the customer: leaving a group and joining another
// keeps it, so a tag already printed still works. Minting and setting
// it in Square are each logged in the group's audit log
// (lib/group-log.mjs, address masked) and as a log line, and neither is
// logged when it changed nothing (#497).

import { randomInt } from "node:crypto";

import { audit } from "./group-log.mjs";
import { memberKeyOf } from "./groups.mjs";
import { log } from "./log.mjs";
import { newPassCode } from "./passes.mjs";
import {
  customerByMemberId, getCustomer, memberIdKey, saveCustomer,
} from "./records.mjs";
import * as square from "./square.mjs";

export const MEMBER_PREFIX = "NFM";

const SHAPE = /^NFM-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

export const MAX_DRAWS = 8;

export const newMemberId = (pick = randomInt) =>
  `${MEMBER_PREFIX}-${newPassCode(pick)}`;

// A code as typed or scanned, in the stored form, or "" when it is not
// one: upper case, the hyphens optional.
export const memberIdOf = (value) => {
  const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const id = raw.length === 11
    ? `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}` : "";

  return SHAPE.test(id) ? id : "";
};

// Who the code belongs to: a code looks the customer up by the code's
// index, anything else is an email address. -> the record, or null.
export const findMember = async (stores, value) => {
  const id = memberIdOf(value);

  return id ? customerByMemberId(stores, id) : getCustomer(stores, value);
};

// The customer's code, minted the first time it is asked for, for a
// member of a group only. `by` is who asked: { role: "farm" } for the
// CLI, { role: "member", email } for the Membership tab. With `apply`
// false nothing is written. -> { memberId, minted, customer }, memberId
// null with `apply` false when one would be minted; or null when the
// address has no record or is in no group and has no code.
export const ensureMemberId = async (stores, email, {
  by, now = new Date(), pick = randomInt, apply = true,
}) => {
  const customer = await getCustomer(stores, email);

  if (!customer) return null;
  if (customer.memberId) {
    return { memberId: customer.memberId, minted: false, customer };
  }

  const group = memberKeyOf(customer);

  if (!group) return null;
  if (!apply) return { memberId: null, minted: true, customer };

  for (let n = 0; n < MAX_DRAWS; n++) {
    const id = newMemberId(pick);

    await stores.customers.create(memberIdKey(id), { email: customer.email });

    // The read is the verdict, as with order ids (lib/records.mjs).
    const holder = await stores.customers.get(memberIdKey(id));

    if (!holder) throw new Error(`The claim on ${id} did not stick.`);
    if (holder.email !== customer.email) continue;

    // Another request minted one while this one drew: theirs stands,
    // and the claim made here goes.
    const fresh = await getCustomer(stores, customer.email);

    if (fresh && fresh.memberId) {
      if (fresh.memberId !== id) await stores.customers.delete(memberIdKey(id));

      return { memberId: fresh.memberId, minted: false, customer: fresh };
    }

    const saved = await saveCustomer(stores, {
      ...(fresh || customer),
      memberId: id,
      memberIdStatus: "active",
      memberIdSetAt: now.toISOString(),
    });

    await audit(stores, {
      group, by, action: "member-id.mint", target: customer.email,
      before: { memberId: null }, after: { memberId: id }, now,
    });
    log.info({ event: "member_id.minted", by: by.role, group,
      outcome: "minted" });

    return { memberId: id, minted: true, customer: saved };
  }

  throw new Error(`No free member ID in ${MAX_DRAWS} draws.`);
};

// The code on the member's Square profile as its reference_id, found by
// email as checkout finds it, or made for them. Idempotent: a profile
// that already says so is left alone, and nothing is logged. With
// `apply` false, Square is only read. `by` as for ensureMemberId.
// -> lib/square.mjs's { customerId, action, was }, or null when the
// customer has no code or is in no group: the log is the group's, and
// a former member's profile keeps whatever it was last given.
export const syncSquareReference = async (stores, customer, {
  by, env = process.env, fetchImpl, now = new Date(), apply = true,
}) => {
  const group = memberKeyOf(customer);

  if (!customer || !customer.memberId || !group) return null;

  const id = customer.memberId;
  const r = await square.setCustomerReference(customer, id, {
    env, fetchImpl, apply,
  });

  if (r.action === "updated" || r.action === "created") {
    await audit(stores, {
      group, by, action: "member-id.square", target: customer.email,
      before: { referenceId: r.was }, after: {
        referenceId: id, squareCustomer: r.customerId, made: r.action ===
          "created",
      },
      now,
    });
    log.info({ event: "member_id.square", by: by.role, outcome: r.action });
  } else if (r.action === "conflict") {
    log.warn({ event: "member_id.square", by: by.role, outcome: "conflict" });
  }

  return r;
};

// Every member of a group: a code for each who has none, then each code
// set in Square, one at a time. A failure for one member is reported
// and the rest go on. With `apply` false nothing is written anywhere.
// -> [{ email, memberId, minted, square | error }]
export const syncMembers = async (stores, members, {
  by, env = process.env, fetchImpl, now = new Date(), apply = true,
  pick = randomInt,
}) => {
  const done = [];

  for (const email of members) {
    try {
      const own = await ensureMemberId(stores, email, {
        by, now, pick, apply,
      });

      if (!own) {
        done.push({ email, memberId: null, minted: false, square: null });
        continue;
      }

      const r = own.memberId
        ? await syncSquareReference(stores, own.customer, {
          by, env, fetchImpl, now, apply,
        })
        : { customerId: null, action: "would-mint-first", was: null };

      done.push({
        email, memberId: own.memberId, minted: own.minted, square: r,
      });
    } catch (error) {
      done.push({ email, error: error.message });
    }
  }

  return done;
};
