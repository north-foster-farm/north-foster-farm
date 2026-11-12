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
  customerByMemberId, customerKey, getCustomer, memberIdKey, swapCustomer,
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
//
// Two first looks at once (two tabs) mint one code between them: the
// code is claimed create-only, then written onto the record only if
// the record is unchanged since it was read (an etag swap). The one
// that loses the swap gives its claim back and reads again, finding the
// winner's code, so there is one code, no leftover claim and one audit
// entry (#131). A code minted here is queued for Square
// (queueSquareReference), which the jobs run sets.
export const ensureMemberId = async (stores, email, {
  by, now = new Date(), pick = randomInt, apply = true,
}) => {
  for (let n = 0; n < MAX_DRAWS; n++) {
    const found = await stores.customers.getTagged(customerKey(email));
    const customer = found && found.value;

    if (!customer) return null;
    if (customer.memberId) {
      return { memberId: customer.memberId, minted: false, customer };
    }

    const group = memberKeyOf(customer);

    if (!group) return null;
    if (!apply) return { memberId: null, minted: true, customer };

    const id = newMemberId(pick);

    // Another member holds this one: draw again.
    if (!(await stores.customers.create(memberIdKey(id), {
      email: customer.email,
    }))) continue;

    const saved = await swapCustomer(stores, {
      ...customer,
      memberId: id,
      memberIdStatus: "active",
      memberIdSetAt: now.toISOString(),
    }, found.etag);

    // The record changed since it was read, perhaps by another first
    // look minting its own: give the claim back and look again.
    if (!saved) {
      await stores.customers.delete(memberIdKey(id));
      continue;
    }

    await audit(stores, {
      group, by, action: "member-id.mint", target: customer.email,
      before: { memberId: null }, after: { memberId: id }, now,
    });
    log.info({ event: "member_id.minted", by: by.role, group,
      outcome: "minted" });
    await queueSquareReference(stores, saved, { by, now });

    return { memberId: id, minted: true, customer: saved };
  }

  throw new Error(`No member ID could be set in ${MAX_DRAWS} tries.`);
};

// --- Setting a minted code in Square, off the page's path -------------
//
// A code minted from the Membership tab or the key tag page must reach
// Square too, without the page waiting on Square or failing when it is
// down. Minting queues it, `member-square/<id>` in the jobs store ->
// { email, by, queuedAt, tries, nextAt }, and each jobs run (every 15
// minutes) sets the codes due through syncSquareReference. A try that
// throws is logged and tried again later, waiting twice as long each
// time up to a day, and from the RETRY_ALERT-th try on the jobs run
// alerts (member.square_retrying). A decided answer (set, already set,
// a conflict, or nothing to set) ends the entry; so does the CLI's sync.
//
// Square refusing outright (a SquareError with `retryable` false: a bad
// token, a request it won't take) is decided too, since asking again
// gets the same answer: the entry stays, marked `refused` with the
// error, is never tried by the jobs again, and is alerted once
// (member.square_refused). `members show`, `mint` and `sync` name it,
// and the CLI's next successful set ends it.
export const squareQueueKey = (id) => `member-square/${id}`;

export const RETRY_FIRST = 15 * 60_000;
export const RETRY_MAX = 24 * 60 * 60_000;
export const RETRY_ALERT = 4;

// One jobs run sets at most DRAIN_MAX codes and stops starting new ones
// after DRAIN_MS, every Square call cut at that deadline, so a slow
// Square costs the run a few seconds at most, well inside the
// function's 30 s. What is left waits for the next run, the longest
// waiting first.
export const DRAIN_MAX = 10;
export const DRAIN_MS = 5000;

// Whether Square has answered for good: asking again won't change it.
export const refusal = (error) => error instanceof square.SquareError
  && !error.retryable;

const errorOf = (error) => {
  const message = String((error && error.message) || error);
  const code = error && error.code;

  return code && !message.includes(code) ? `${message} (${code})` : message;
};

export const retryAfter = (tries) =>
  Math.min(RETRY_FIRST * 2 ** Math.max(tries - 1, 0), RETRY_MAX);

export const queueSquareReference = async (stores, customer, {
  by, now = new Date(),
}) => {
  await stores.jobs.set(squareQueueKey(customer.memberId), {
    email: customer.email,
    by: { role: by.role },
    queuedAt: now.toISOString(),
    tries: 0,
    nextAt: now.toISOString(),
  });
};

// Every code waiting for Square, due now or not. -> [{ id, ...entry }]
export const squareQueue = async (stores) => {
  const keys = await stores.jobs.list("member-square/");

  return (await Promise.all(keys.map(async ({ key }) => {
    const entry = await stores.jobs.get(key);

    return entry && { id: key.slice("member-square/".length), ...entry };
  }))).filter(Boolean);
};

// The code's entry, or null when none waits. A refused one has
// `refused: true`, `refusedAt` and `lastError`.
export const squareQueueEntry = async (stores, id) => {
  const entry = id ? await stores.jobs.get(squareQueueKey(id)) : null;

  return entry ? { id, ...entry } : null;
};

// The jobs run's step: each code due set in Square, one at a time, the
// longest waiting first, at most `max` of them and none started after
// `ms` of real time (`clock`, for tests). -> { done, left }, done
// [{ id, outcome, tries, alert?, error? }] with outcome the action
// Square's answer took, "dropped" when there was nothing to set,
// "refused" when Square said no for good, or "retry"; left the count of
// codes due that waits for the next run.
export const drainSquareQueue = async (stores, {
  env = process.env, fetchImpl, now = new Date(), max = DRAIN_MAX,
  ms = DRAIN_MS, clock = Date.now,
} = {}) => {
  const done = [];
  const deadline = clock() + ms;
  const due = (await squareQueue(stores))
    .filter((e) => !e.refused && Date.parse(e.nextAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt)
      || a.id.localeCompare(b.id));
  let n = 0;

  for (; n < due.length; n++) {
    if (n >= max || clock() >= deadline) break;

    const entry = due[n];
    const key = squareQueueKey(entry.id);
    const by = entry.by && entry.by.role ? entry.by : { role: "member" };
    const tries = entry.tries + 1;

    try {
      const customer = await getCustomer(stores, entry.email);
      // A code no longer the record's (renamed away, deleted, replaced)
      // has nothing to set.
      const r = customer && customer.memberId === entry.id
        ? await syncSquareReference(stores, customer, {
          by: by.role === "member" ? { role: "member",
            email: customer.email } : by,
          env, fetchImpl, now, deadline,
        })
        : null;

      await stores.jobs.delete(key);
      done.push({ id: entry.id, outcome: r ? r.action : "dropped", tries });
    } catch (error) {
      const message = errorOf(error);
      const kept = {
        email: entry.email, by: entry.by, queuedAt: entry.queuedAt,
        tries, lastError: message,
      };

      if (refusal(error)) {
        await stores.jobs.set(key, {
          ...kept, refused: true, refusedAt: now.toISOString(),
          nextAt: entry.nextAt,
        });
        log.warn({ event: "member_id.square", by: by.role,
          outcome: "refused", tries });
        done.push({ id: entry.id, outcome: "refused", tries,
          error: message });
        continue;
      }

      await stores.jobs.set(key, {
        ...kept,
        nextAt: new Date(now.getTime() + retryAfter(tries)).toISOString(),
      });
      log.warn({ event: "member_id.square", by: by.role, outcome: "retry",
        tries });
      done.push({ id: entry.id, outcome: "retry", tries, error: message,
        alert: tries >= RETRY_ALERT });
    }
  }

  const left = due.length - n;

  if (left) log.info({ event: "member_id.square_drain", left });

  return { done, left };
};

// The code on the member's Square profile as its reference_id, found by
// email as checkout finds it, or made for them. Idempotent: a profile
// that already says so is left alone, and nothing is logged. With
// `apply` false, Square is only read. `by` as for ensureMemberId.
// -> lib/square.mjs's { customerId, action, was }, or null when the
// customer has no code or is in no group: the log is the group's, and
// a former member's profile keeps whatever it was last given.
// `deadline` (a Date.now() value) cuts each Square call short.
export const syncSquareReference = async (stores, customer, {
  by, env = process.env, fetchImpl, now = new Date(), apply = true,
  deadline,
}) => {
  const group = memberKeyOf(customer);

  if (!customer || !customer.memberId || !group) return null;

  const id = customer.memberId;
  const r = await square.setCustomerReference(customer, id, {
    env, fetchImpl, apply, deadline,
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
  // Decided: nothing left for the jobs run to try (a dry run decides
  // nothing).
  if (apply) await stores.jobs.delete(squareQueueKey(id));

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
