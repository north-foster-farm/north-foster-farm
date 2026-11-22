// The email addresses a bin/nff command is given, each decoded once,
// cleaned and checked before the command runs (#758): an address
// encoded once ("pat%2Bdog%40example.com") reaches the command as
// "pat+dog@example.com", and one that fails stops the run with an
// error naming it, never a "No such customer".
import { receivedEmail } from "../assets/scripts/utils/email.js";

// "group action" -> the positions in `rest` that hold an address. An
// empty position (perks list with no address) is left alone. login and
// masquerade take theirs as the action, and --email is checked on any
// command that is given one.
export const ADDRESS_ARGS = {
  "customers show": [0],
  "customers set": [0],
  "customers rename": [0, 1],
  "customers forget": [0],
  "customers delete": [0],
  "address approve": [0],
  "address deny": [0],
  "perks add": [0],
  "perks list": [0],
  "perks remove": [0],
  "groups remove": [1],
  "groups walkin": [1],
  "groups credit": [0],
  "audience remove": [0],
};
const ACTION_IS_ADDRESS = ["login", "masquerade"];

const checked = (value) => {
  const address = receivedEmail(value);

  if (!address) {
    throw new Error(`Not a valid email address: ${JSON.stringify(value)}. `
      + "Nothing was looked up or changed.");
  }

  return address;
};

// -> { action, rest, flags } with every address in its checked form;
// throws on the first that fails.
export const addressArgs = (group, action, rest, flags) => {
  const at = ADDRESS_ARGS[`${group} ${action}`] || [];

  return {
    action: ACTION_IS_ADDRESS.includes(group) && action !== undefined
      ? checked(action) : action,
    rest: rest.map((value, i) => (at.includes(i) && value !== undefined
      ? checked(value) : value)),
    flags: typeof flags.email === "string"
      ? { ...flags, email: checked(flags.email) } : flags,
  };
};
