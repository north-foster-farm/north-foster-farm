// `bin/nff members ...`: a member's code (#131, lib/member-id.mjs), shown,
// minted, and set as the reference_id of their Square profile. The
// output names the member: keep it off GitHub. Production runs are
// James's: `mint` and `sync` ask for typed confirmation there
// (bin/confirm.mjs), and `--dry-run` writes nothing.

import { writeFileSync } from "node:fs";

import { groupMembers } from "../netlify/functions/lib/group-log.mjs";
import { groupOf, memberKeyOf } from "../netlify/functions/lib/groups.mjs";
import {
  findMember, squareQueue, squareQueueEntry, syncMembers, syncSquareReference,
} from "../netlify/functions/lib/member-id.mjs";
import { qrSvg } from "../netlify/functions/lib/qr.mjs";

// The usage lines are bin/nff's. bin/nff loads this module only for a
// members command, after its environment is set.

const FARM = { role: "farm" };

// What `show` says of the Square profile, by setCustomerReference's
// action with `apply` false.
const SHOWN = {
  unchanged: () => "the profile's reference_id is the code",
  "would-update": (r) => `reference_id is ${r.was || "empty"}; members mint `
    + "sets it",
  "would-create": () => "no profile under this address; members mint makes "
    + "one",
  conflict: (r) => `reference_id is ${r.was}, which the site didn't write; `
    + "change it in the Square Dashboard",
};

// What `mint` and `sync` say, by the action Square's answer took.
const SAID = {
  unchanged: "Square already has it",
  updated: "set in Square",
  created: "a Square profile made with it",
  conflict: "NOT set: the Square profile's reference_id is",
  "would-update": "would be set in Square",
  "would-create": "a Square profile would be made with it",
  "would-mint-first": "would be minted, then set in Square",
};

const line = (d, dry) => {
  if (d.error) return `${d.email}  error: ${d.error}`;
  if (!d.memberId && !d.square) {
    return `${d.email}  not in a group: nothing done`;
  }

  const s = d.square;
  const minted = d.minted ? (dry ? "  would be minted" : "  minted") : "";
  const square = s
    ? `${SAID[s.action]}${s.action === "conflict" ? ` ${s.was}` : ""}`
    : "in no group, so not set in Square";

  return `${d.email}  ${d.memberId || "(new code)"}${minted}  ${square}`;
};

// What a code's entry in the jobs' queue for Square says
// (lib/member-id.mjs squareQueue).
const queued = (e) => {
  const tries = `${e.tries} ${e.tries === 1 ? "try" : "tries"}`;

  if (e.refused) {
    return `Square refused it on ${e.refusedAt} (${e.lastError}), after `
      + `${tries}; the jobs won't try again. members mint sets it`;
  }

  return `waiting to be set in Square, next try ${e.nextAt}${
    e.tries ? ` (${tries}, last: ${e.lastError})` : ""}`;
};

// `env` and `fetchImpl` reach Square (the fake where env says so);
// `writeFile` is for tests.
export const membersCommand = async (action, rest, {
  stores, flags, out, env = process.env, fetchImpl, now = new Date(),
  writeFile = writeFileSync,
}) => {
  if (action === "show") {
    const c = await findMember(stores, rest[0] || "");

    if (!c) throw new Error(`No customer for "${rest[0] || ""}".`);

    const group = groupOf(memberKeyOf(c));
    const r = c.memberId && group
      ? await syncSquareReference(stores, c, {
        by: FARM, env, fetchImpl, now, apply: false,
      })
      : null;

    out(`${c.email}  ${c.memberId || "no code yet"}  ${
      group ? group.key : "in no group"}`);
    if (r) out(`Square: ${SHOWN[r.action](r)}`);

    const waiting = await squareQueueEntry(stores, c.memberId);

    if (waiting) out(`Jobs: ${queued(waiting)}`);
    if (typeof flags.out === "string") {
      if (!c.memberId) throw new Error("No code to draw: members mint first.");

      writeFile(flags.out, qrSvg(c.memberId, {
        title: `Member code ${c.memberId}`,
      }));
      out(`Wrote ${flags.out}.`);
    }

    return undefined;
  }

  if (action !== "mint" && action !== "sync") {
    throw new Error(`Unknown command "members ${action || ""}".`);
  }

  const dry = !!flags["dry-run"];
  let emails;

  if (action === "mint") {
    if (!rest[0]) throw new Error("members mint <email>");
    emails = [rest[0]];
  } else {
    const g = groupOf(rest[0]);

    if (!g) throw new Error(`Unknown group "${rest[0] || ""}".`);
    emails = (await groupMembers(stores, g.key)).map((m) => m.email);
  }

  // Codes Square refused for good, read before this run may end them.
  const refused = new Map((await squareQueue(stores))
    .filter((e) => e.refused).map((e) => [e.id, e]));
  const done = await syncMembers(stores, emails, {
    by: FARM, env, fetchImpl, now, apply: !dry,
  });

  for (const d of done) {
    out(line(d, dry));

    const was = d.memberId && refused.get(d.memberId);

    if (was) out(`  ${queued(was)}`);
  }
  if (!done.length) out("No members.");
  if (dry) out("--dry-run: nothing was written.");

  return undefined;
};
