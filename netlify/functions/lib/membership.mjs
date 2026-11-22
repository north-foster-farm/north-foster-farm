// The Membership tab (#495, part 5): what a buying group's member sees
// of their group, and what its host sees besides. A member is the
// customer whose record names the group; the host is the signed-in
// email address the farm set as the group's host (`groups set
// host=`), and sees the group as a member does besides (#772), though
// no member list or count includes them unless their record names the
// group. Anyone else is told nothing, not even that a group exists.
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
  addDays, instant, today,
} from "../../../assets/scripts/order/lib/zoned.mjs";
import { normalizeEmail } from "./auth.mjs";
import { creditBalance, voidCredit } from "./credit.mjs";
import { audit, groupMembers } from "./group-log.mjs";
import {
  GROUPS, getGroupRecord, groupOf, leaveGroup, memberKeyOf, namedGroup,
  privatePlaces, shortUrl,
} from "./groups.mjs";
import { ensureMemberId } from "./member-id.mjs";
import { qrSvg } from "./qr.mjs";
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
// when they are neither. A member of one group can host another and
// stays the first's member. A host in no group is a member of the one
// they host (#772), derived and never written, so `byHost` marks it:
// they have no record membership to leave.
export const roleOf = async (stores, session) => {
  if (!session) return null;

  const own = groupOf(memberKeyOf(session.customer));
  const hosts = await hostedGroups(stores, session.email);
  const member = own || hosts[0] || null;

  if (!member) return null;

  return { member, hosts, byHost: !own };
};

// The group a host's request names, when this address hosts it, or
// null: a host acts only on a group named in the request, never on
// the one they belong to by default.
export const hostedBy = (role, key) =>
  (role && typeof key === "string" && role.hosts.find((g) => g.key === key))
  || null;

// When a pickup day is over: the end of its window, or the end of the
// day when the series names no hours.
const pickupEnd = (date, s, timeZone) => {
  if (!s.closes) return cutoffOf(addDays(date, 1), timeZone).getTime() + 60000;

  const [hour, minute] = s.closes.split(":").map(Number);

  return instant(date, hour, minute, timeZone).getTime();
};

// The round being ordered for now, and the one after: each with its
// pickup day and when ordering for it closes (11:59 PM the day
// before). The next one opens as this one closes.
//
// Between a round's close and the end of its pickup (#600) that round
// is `closed`: the pickup the members just ordered for, which would
// otherwise leave the tab the night before it happens. Null at any
// other time. `current` is null only when no round is open and one is
// closed, the series' last.
export const roundsNow = (group, terms, now = new Date()) => {
  const s = terms.model.seriesOf(group.series);

  if (!s) return null;

  const zone = terms.timeZone;
  const from = today(now, zone);
  const at = now.getTime();
  const past = (d) => cutoffOf(d, zone).getTime() <= at;
  const open = seriesDates(s, from, addDays(from, 400))
    .filter((d) => !past(d));
  // A closed round's pickup is today or, in the last minute of the
  // day before it, tomorrow.
  const [closed] = seriesDates(s, from, addDays(from, 1))
    .filter((d) => past(d) && pickupEnd(d, s, zone) > at);
  const [current, next] = open;

  if (!current && !closed) return null;

  const closes = current ? cutoffOf(current, zone).toISOString() : null;

  return {
    every: s.every || 1,
    opens: s.opens || null,
    closes: s.closes || null,
    closed: closed
      ? { date: closed, closedAt: cutoffOf(closed, zone).toISOString() }
      : null,
    current: current ? { date: current, closesAt: closes } : null,
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

// The member's own code (#131), minted the first time their tab asks
// for it, which logs it as the member's act. With `mint` false (the
// site in maintenance) only one already minted is shown.
// -> { id } or null.
export const memberCode = async (stores, email, {
  now = new Date(), mint = true,
} = {}) => {
  const own = await ensureMemberId(stores, email, {
    by: { role: "member", email }, now, apply: mint,
  });

  return own && own.memberId ? { id: own.memberId } : null;
};

// The code as the tab and the key tag draw it: dark on white, sized by
// the page. The QR holds the code alone, as plain text, which is what
// the Square Point of Sale app reads at the stand.
export const memberCodeSvg = (id) =>
  qrSvg(id, { title: `Member code ${id}` });

// The host's join link as the tab takes it, for the field beside the
// QR code (#579): the group's short link (#589), which the QR code
// holds too. Never the token, so no host can hand out a link the farm
// would have to retire. The view writes nothing: the short link mints
// the group's first token when it is first followed.
export const hostQr = (key, env = process.env) => ({
  link: shortUrl(key, env),
});

// What the tab shows: the member's own group and code, and every group
// they host with its QR code and members. When both are the same group,
// it is in both. `email` is the signed-in address, for the code, and
// `mint` as for memberCode. The join link is in the host's part alone.
// -> { member: { key, group, rounds, code } | null,
// hosts: [{ key, group, rounds, qr: { link }, members }] }
export const membershipView = async (stores, role, {
  terms, now, email, mint = true, env = process.env,
}) => ({
  member: role.member
    ? {
      ...(await groupView(stores, role.member, { terms, now })),
      // A host's derived membership mints no code (#772): no write.
      code: email && !role.byHost
        ? await memberCode(stores, email, { now, mint }) : null,
      ...(role.byHost ? { byHost: true } : {}),
    }
    : null,
  hosts: await Promise.all(role.hosts.map(async (g) => ({
    ...(await groupView(stores, g, { terms, now })),
    qr: hostQr(g.key, env),
    members: await hostMembers(stores, g.key),
  }))),
});
