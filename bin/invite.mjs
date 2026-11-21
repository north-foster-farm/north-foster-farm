// `bin/nff invite add|list|revoke` (#718): the farm's invite links
// (netlify/functions/lib/invites.mjs).
//
//   invite add <perk> [--end YYYY-MM-DD] [--note "..."] [--square <id>]
//              [--owner]   a single-use link for the perk, open 14 days,
//                          printed here and nowhere else; James sends it
//   invite list            every invite: open, used, expired or revoked
//   invite revoke <id>     ends one
//
// Making and revoking are production writes, logged by the library,
// and asked for on production as every other grant is (bin/confirm.mjs);
// `list` only reads. The link holds the token, so keep it off GitHub.

import { userInfo } from "node:os";

import {
  addInvite, listInvites, revokeInvite,
} from "../netlify/functions/lib/invites.mjs";

export const USAGE = "bin/nff invite add <perk> [--end YYYY-MM-DD] " +
  "[--note \"...\"] [--square <customer id>] [--owner] | list | " +
  "revoke <id>";

const flagOn = (value) => !!value && value !== "false";

const valued = (flags, name) => {
  const value = flags[name];

  if (value === true) throw new Error(`--${name} needs a value.`);

  return value || null;
};

// -> what the command did, said through `out`. `confirm(command)`
// resolves true to go ahead.
export const inviteCommand = async (action, rest, {
  stores, flags = {}, out, confirm = async () => true, env = process.env,
} = {}) => {
  const by = userInfo().username;

  if (action === "list") {
    const rows = await listInvites(stores);

    for (const r of rows) {
      out(`${r.id}  ${r.perk}  ${r.state}  made ${r.createdAt.slice(0, 10)}${
        r.state === "open"
          ? `, open until ${new Date(r.expires).toISOString().slice(0, 10)}`
          : ""}${r.end ? `  perk through ${r.end}` : ""}${
        r.square ? "  Square customer" : ""}${
        r.usedBy ? `  used by ${r.usedBy}` : ""}${
        r.note ? `  ${r.note}` : ""}`);
    }
    if (!rows.length) out("No invites.");

    return undefined;
  }

  if (action === "add") {
    if (!rest[0]) throw new Error(`Usage: ${USAGE}`);
    if (!await confirm({ group: "invite", action, rest })) return undefined;

    const made = await addInvite(stores, rest[0], {
      end: valued(flags, "end"), note: valued(flags, "note"),
      square: valued(flags, "square"), owner: flagOn(flags.owner), by, env,
    });

    out(`Made invite ${made.id} for ${rest[0]}, open until ${
      made.expires.slice(0, 10)}. Send this link yourself; it works once:`);

    return out(made.url);
  }

  if (action === "revoke") {
    if (!rest[0]) throw new Error(`Usage: ${USAGE}`);
    if (!await confirm({ group: "invite", action, rest })) return undefined;

    const r = await revokeInvite(stores, rest[0], { by });

    return out(`Revoked ${r.id}.`);
  }

  throw new Error(`Usage: ${USAGE}`);
};
