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

// Every group whose host this address is: none, one or more.
export const hostedGroups = async (stores, email) => {
  const address = normalizeEmail(email);
  const hosted = [];

  if (!address) return hosted;
  for (const g of GROUPS) {
    const record = await getGroupRecord(stores, g.key);

    if (record && record.host && record.host === address) hosted.push(g);
  }

  return hosted;
};

// Who the signed-in customer is to the groups, worked out separately
// (James, 6458200999): { member, hosts }, where `member` is the group
// they belong to or null and `hosts` every group they run, or null
// when they are neither. A host who is not a member still runs the
// group, and a member of one group can host another.
export const roleOf = async (stores, session) => {
  if (!session) return null;

  const member = groupOf(memberKeyOf(session.customer));
  const hosts = await hostedGroups(stores, session.email);

  if (!member && hosts.length === 0) return null;

  return { member, hosts };
};

// The group a host's request names, when this address hosts it, or
// null: a host acts only on a group named in the request, never on
// the one they belong to by default.
export const hostedBy = (role, key) =>
  (role && typeof key === "string" && role.hosts.find((g) => g.key === key))
  || null;

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

// One group as the tab shows it. -> { key, group, rounds }
const groupView = async (stores, group, { terms, now }) => ({
  key: group.key,
  group: {
    name: (await namedGroup(stores, group)).name, place: placeOf(group),
  },
  rounds: roundsNow(group, terms, now),
});

// A hosted group's members, as its host sees them.
export const hostMembers = async (stores, key) =>
  (await groupMembers(stores, key)).map((m) => ({
    email: m.email, name: m.name, joinedAt: m.joinedAt, via: m.via,
  }));

// What the tab shows: the member's own group, and every group they
// host with its QR code and members. When both are the same group, it
// is in both. -> { member: { key, group, rounds } | null,
// hosts: [{ key, group, rounds, qr, members }] }
export const membershipView = async (stores, role, { terms, now }) => ({
  member: role.member
    ? await groupView(stores, role.member, { terms, now }) : null,
  hosts: await Promise.all(role.hosts.map(async (g) => {
    const record = await getGroupRecord(stores, g.key);

    return {
      ...(await groupView(stores, g, { terms, now })),
      // The QR code's version: the image is fetched again when it moves.
      qr: { setAt: (record && record.joinTokenSetAt) || null },
      members: await hostMembers(stores, g.key),
    };
  })),
});
