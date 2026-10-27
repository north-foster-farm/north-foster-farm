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
import { groupMembers } from "./group-log.mjs";
import {
  GROUPS, getGroupRecord, groupOf, memberKeyOf, namedGroup, privatePlaces,
} from "./groups.mjs";
import { normalizeEmail } from "./auth.mjs";

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
