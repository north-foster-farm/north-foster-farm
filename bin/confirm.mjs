// A typed confirmation before bin/nff changes production (#268, rec
// 9): anything that cancels, refunds or deletes, or changes an order or
// the stock, asks for the thing it acts on, typed out, unless --yes
// says a script has already decided. Staging and a local run never ask.

// What each command acts on, by "group action". `target` names the
// word to type; `apply` is true for a command that only reports until
// --apply (then it asks only with the flag).
const DESTRUCTIVE = {
  "orders cancel": { does: "cancel and maybe refund order" },
  "orders refund": { does: "refund order" },
  "orders delete": { does: "delete order" },
  "orders fulfil": { does: "mark order delivered" },
  "orders fulfill": { does: "mark order delivered" },
  "orders attempted": { does: "mark order attempted" },
  "returns resolve": { does: "resolve the return on order" },
  "customers delete": { does: "delete customer" },
  "customers rename": { does: "move the account of", apply: true },
  "customers forget": { does: "erase the details of", apply: true },
  "stock set": { does: "set the stock count of" },
  "jobs square": {
    does: "cancel the abandoned Square orders", apply: true, whole: true,
  },
  "jobs customers": {
    does: "delete the Square profiles of failed payments",
    apply: true, whole: true,
  },
};

// -> { does, phrase } for a command that needs a typed answer, or null.
// `phrase` is the order id, email address or SKU the command names, or
// the command itself for a sweep that names nothing.
export const confirmation = ({ group, action, rest = [], flags = {} }) => {
  const rule = DESTRUCTIVE[`${group} ${action}`];

  if (!rule || (rule.apply && !flags.apply)) return null;

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
