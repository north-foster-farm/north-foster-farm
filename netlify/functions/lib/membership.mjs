// The Membership tab (#495, part 5): what a buying group's member sees
// of their group, and what its host sees besides. A member is the
// customer whose record names the group; the host is the signed-in
// email address the farm set as the group's host (`groups set
// host=`). Anyone else is told nothing, not even that a group exists.
//
// Members see the group's name, its pickup place, how often its rounds
// run, when the round being ordered for closes and when the next one
// opens. The host also gets the join QR code and the member list:
// name, email address, date joined and how. No one sees another
// member's orders, phone number, address or payments.

import {
  cutoffOf, seriesDates,
} from "../../../assets/scripts/order/lib/events.mjs";
import {
  addDays, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { normalizeEmail } from "./auth.mjs";
import { creditBalance, voidCredit } from "./credit.mjs";
import { audit, groupMembers } from "./group-log.mjs";
import {
  GROUPS, getGroupRecord, groupOf, leaveGroup, memberKeyOf, namedGroup,
  privatePlaces,
} from "./groups.mjs";
import { getCustomer } from "./records.mjs";

// The group whose host this address is, or null.
export const hostedGroup = async (stores, email) => {
  const address = normalizeEmail(email);

  if (!address) return null;
  for (const g of GROUPS) {
    const record = await getGroupRecord(stores, g.key);

    if (record && record.host && record.host === address) return g;
  }

  return null;
};

// Who the signed-in customer is to a group: { group, member, host },
// or null when they are neither. A host who is not a member still
// runs the group.
export const roleOf = async (stores, session) => {
  if (!session) return null;

  const own = groupOf(memberKeyOf(session.customer));
  const hosted = await hostedGroup(stores, session.email);
  const group = own || hosted;

  if (!group) return null;

  return {
    group,
    member: !!own && own.key === group.key,
    host: !!hosted && hosted.key === group.key,
  };
};

// The round being ordered for now, and the one after: each with its
// pickup day and when ordering for it closes (11:59 PM the day
// before). The next one opens as this one closes.
export const roundsNow = (group, terms, now = new Date()) => {
  const s = terms.model.seriesOf(group.series);

  if (!s) return null;

  const from = today(now, terms.timeZone);
  const open = seriesDates(s, from, addDays(from, 400))
    .filter((d) => cutoffOf(d, terms.timeZone).getTime() > now.getTime());
  const [current, next] = open;

  if (!current) return null;

  const closes = cutoffOf(current, terms.timeZone).toISOString();

  return {
    every: s.every || 1,
    opens: s.opens || null,
    closes: s.closes || null,
    current: { date: current, closesAt: closes },
    next: next ? { date: next, opensAt: closes } : null,
  };
};

// The pickup place, as members see it.
const placeOf = (group) => {
  const l = privatePlaces(group).locations[0];

  return l
    ? { name: l.name, street: l.street, city: l.city, state: l.state,
      zip: l.zip }
    : null;
};

// A member out of the group (#495, part 6): the host's Remove, the
// member's own Leave group, or `bin/nff groups remove`. One logged act.
// Their open orders stand as placed, at their prices and pickup, and
// count toward the round; a change can no longer move one into a round
// (offeredGroup in lib/groups.mjs). Their credit stays theirs, the
// account's (James, decision 6). They get no share of a reward
// settled after this (lib/rounds.mjs). `action` is "member.remove" or
// "member.leave". -> { ok } or { ok: false } when they are not in it.
export const removeMember = async (stores, key, email, {
  by, action = "member.remove", now = new Date(),
}) => {
  const address = normalizeEmail(email);
  const customer = await getCustomer(stores, address);

  if (!customer || memberKeyOf(customer) !== key) return { ok: false };

  const was = customer.memberGroup;

  await leaveGroup(stores, address);
  await audit(stores, {
    group: key, by, action, target: address,
    before: {
      group: key, joinedAt: was.joinedAt || null, via: was.via || null,
    },
    after: { group: null },
    now,
  });

  return { ok: true };
};

// The farm voids someone's credit for abuse (#495): `bin/nff groups
// credit <email> --void`. Logged in each group whose grants it voided,
// with that group's part, and nowhere when nothing was left: a change
// that didn't happen is not logged (#497). -> { voided, byGroup }
export const voidMemberCredit = async (stores, email, {
  by, now = new Date(),
}) => {
  const address = normalizeEmail(email);
  const before = await creditBalance(stores, address, now);
  const { voided, byGroup } = await voidCredit(stores, address, {
    now, reason: by.role,
  });

  for (const [key, amount] of Object.entries(byGroup)) {
    await audit(stores, {
      group: key, by, action: "credit.void", target: address,
      before: { balance: before },
      after: { balance: before - voided, voided: amount },
      now,
    });
  }

  return { voided, byGroup };
};

// What the tab shows. -> { group, rounds, host, members? , qr? }
export const membershipView = async (stores, role, { terms, now }) => {
  const named = await namedGroup(stores, role.group);
  const view = {
    member: role.member,
    host: role.host,
    group: { name: named.name, place: placeOf(role.group) },
    rounds: roundsNow(role.group, terms, now),
  };

  if (!role.host) return view;

  const record = await getGroupRecord(stores, role.group.key);

  return {
    ...view,
    // The QR code's version: the image is fetched again when it moves.
    qr: { setAt: (record && record.joinTokenSetAt) || null },
    members: (await groupMembers(stores, role.group.key)).map((m) => ({
      email: m.email, name: m.name, joinedAt: m.joinedAt, via: m.via,
    })),
  };
};
