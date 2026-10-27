// A typed confirmation before bin/nff changes production (#268, rec
// 9): anything that cancels, refunds or deletes, changes an order, a
// customer, a pass or the stock, sends to customers, or switches the
// site or its schedule, asks for the thing it acts on, typed out,
// unless --yes says a script has already decided. Staging and a local
// run never ask. `sessions end-all` and `env push` ask for themselves.

// What each command acts on, by "group action". `target` names the
// word to type; `apply` is true for a command that only reports until
// --apply (then it asks only with the flag); `only` names a flag
// without which the command only reads; `when` is a test of the
// words after the action, for a command only some of whose forms act.
//
// Left unguarded on purpose: `passes issue`, which only adds a pass
// that `passes revoke` takes back. `square deletions status` changes
// nothing.
const DESTRUCTIVE = {
  "orders cancel": { does: "cancel and maybe refund order" },
  "orders refund": { does: "refund order" },
  "orders delete": { does: "delete order" },
  "orders change": { does: "change the pickup or delivery of order",
    unless: "dry-run" },
  "orders move": { does: "move the delivery of order" },
  // Makes an order in Square and the stores, and may record money
  // (#181); it names no id yet, so the command itself is typed.
  "orders create": { does: "make an order for a customer, running",
    unless: "dry-run", whole: true },
  "orders pay": { does: "record money in Square on order" },
  "orders fulfil": { does: "mark order delivered" },
  "orders fulfill": { does: "mark order delivered" },
  "orders attempted": { does: "mark order attempted" },
  "returns resolve": { does: "resolve the return on order" },
  "customers delete": { does: "delete customer" },
  "customers set": { does: "change the details of", unless: "dry-run" },
  "address approve": { does: "approve the delivery address of" },
  "address deny": { does: "deny the delivery address of" },
  "passes revoke": { does: "revoke the pass" },
  // Replacing the code kills the link the host handed out (#471).
  "groups code": { does: "replace the code of the group" },
  "groups set": { does: "change the host of the group" },
  // Prints the QR link, and with --rotate kills the printed one (#495).
  "groups qr": { does: "replace the QR code of the group", only: "rotate" },
  // Reads the members, and with --backfill logs those from before the
  // join log (#495).
  "groups members": { does: "backfill the join log of the group",
    only: "backfill" },
  // Makes a paid order in Square and the stores (#471).
  "groups walkin": { does: "record a walk-in sale, running",
    unless: "dry-run", whole: true },
  "groups reward": { does: "record the host's choice, running",
    whole: true },
  "groups close": { does: "close rounds and grant credit, running",
    whole: true },
  "customers rename": { does: "move the account of", apply: true },
  "customers forget": { does: "erase the details of", apply: true },
  "stock set": { does: "set the stock count of" },
  "maintenance on": { does: "put the site in maintenance, running",
    whole: true },
  "maintenance off": { does: "take the site out of maintenance, running",
    whole: true },
  "maintenance rotate": { does: "kill every maintenance link, running",
    whole: true },
  "schedule set": { does: "replace the pickup schedule, running",
    whole: true },
  "jobs run": { does: "run every job, which emails customers, running",
    whole: true },
  "audience import": {
    does: "put the old list on farm news, emailing the welcomes unless "
      + "--skip, running",
    unless: "dry-run", whole: true,
  },
  "audience welcome": {
    does: "email the farm-news welcomes the old list is owed, running",
    unless: "dry-run", whole: true,
  },
  "audience remove": {
    does: "take out of our records the imported address", unless: "dry-run",
  },
  "audience apply": {
    does: "set names and erase the details of the addresses in the CSV, "
      + "running", unless: "dry-run", whole: true,
  },
  "audience sync": { does: "sync the audience, running",
    unless: "dry-run", whole: true },
  "migrate scheduled-pickup": {
    does: "rewrite every Stage 1 pickup order, running", unless: "dry-run",
    whole: true,
  },
  "square deletions": {
    does: "pause or resume the Square deletion jobs, running",
    when: ([word]) => word === "pause" || word === "resume", whole: true,
  },
  "jobs square": {
    does: "cancel the abandoned Square orders", apply: true, whole: true,
  },
  "jobs customers": {
    does: "delete the Square profiles of failed payments",
    apply: true, whole: true,
  },
};

// Every "group action" the gate covers, for the test that holds each
// command in bin/nff to it or to a list of those that change nothing.
export const GUARDED = Object.keys(DESTRUCTIVE);

// -> { does, phrase } for a command that needs a typed answer, or null.
// `phrase` is the order id, email address or SKU the command names, or
// the command itself for a sweep that names nothing.
export const confirmation = ({ group, action, rest = [], flags = {} }) => {
  const rule = DESTRUCTIVE[`${group} ${action}`];

  if (!rule || (rule.apply && !flags.apply)
    || (rule.only && !flags[rule.only])
    || (rule.when && !rule.when(rest))
    || (rule.unless && flags[rule.unless])) return null;

  const phrase = rule.whole ? `${group} ${action}` : rest[0];

  return phrase ? { does: rule.does, phrase } : null;
};

// Asks, when production's command needs it. -> true to go ahead.
// `ask(question)` resolves with the typed line, and is null when
// there is no terminal to type at.
export const confirmed = async (command, {
  context, flags = {}, ask, say = console.error,
}) => {
  if (context !== "production" || flags.yes) return true;

  const needed = confirmation({ ...command, flags });

  if (!needed) return true;
  if (!ask) {
    say(`Production: this would ${needed.does} ${needed.phrase}. There is `
      + "no terminal to confirm at; pass --yes to go ahead.");

    return false;
  }

  const answer = await ask(
    `Production: ${needed.does} ${needed.phrase}? Type "${needed.phrase}" `
    + "to go ahead: "
  );

  if (answer.trim() === needed.phrase) return true;
  say("Nothing changed.");

  return false;
};
