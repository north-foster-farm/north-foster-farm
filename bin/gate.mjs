// `bin/nff gate ...`: the allowlist and the sessions of the access gate
// that stands in front of every non-production deploy
// (netlify/functions/lib/gate.mjs, docs/staging.md). There is no gate
// in production, so these refuse it.

import {
  addAllow, endSessions, listAllow, normalize, removeAllow,
} from "../netlify/functions/lib/gate.mjs";

export const USAGE = `  bin/nff gate allow list --staging
  bin/nff gate allow add <email|@domain> --staging
  bin/nff gate allow remove <email|@domain> --staging
                                      who may sign in to staging: exact
                                      addresses, or every address at a
                                      domain (@example.com, not its
                                      subdomains). Removing an entry
                                      ends the sessions it let in
  bin/nff gate sessions end <email> --staging
  bin/nff gate sessions end-all --yes --staging
                                      sign people out of staging. A
                                      session lasts a year otherwise`;

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const gateCommand = async (action, rest, {
  stores, flags, out, context, now = new Date(),
}) => {
  if (context === "production") {
    throw new Error("There is no access gate in production.");
  }

  const [verb, value] = rest;
  const store = stores.gate;

  if (action === "allow" && verb === "list") {
    const entries = await listAllow(store);

    if (!entries.length) return out("The allowlist is empty.");
    for (const e of entries) out(`${e.entry}  added ${e.addedAt}`);

    return undefined;
  }
  if (action === "allow" && verb === "add" && value) {
    const entry = await addAllow(store, value, now);

    return out(`Added ${entry}.`);
  }
  if (action === "allow" && verb === "remove" && value) {
    const { entry, ended } = await removeAllow(store, value);

    return out(`Removed ${entry}; ended ${count(ended, "session")}.`);
  }
  if (action === "sessions" && verb === "end" && value) {
    const email = normalize(value);
    const ended = await endSessions(store, (e) => e === email);

    return out(`Ended ${count(ended, "session")} of ${email}.`);
  }
  if (action === "sessions" && verb === "end-all") {
    if (!flags.yes) {
      return out("Add --yes to end every session on this context.");
    }

    return out(`Ended ${count(await endSessions(store), "session")}.`);
  }

  throw new Error("Usage: gate allow list|add|remove <email|@domain>, "
    + "gate sessions end <email>|end-all --yes.");
};
