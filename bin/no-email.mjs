// `--no-email` skips a customer's transactional email: an order's
// notice, a cancellation, a refund, an address decision. The retention
// and news emails (the quiet-account notice, the farm-news welcome and
// confirmation link) are not transactional and are not covered, so a
// command that can send one refuses the flag rather than promise what
// it can't keep.

const SENDS_NEWS = {
  "jobs run": "the daily jobs send the quiet-account notices and the " +
    "farm-news welcome",
  "audience invite": "an invitation is a farm-news confirmation link",
};

// -> the refusal's words, or null when the command may run.
export const noEmailRefusal = (group, action) => {
  const why = SENDS_NEWS[`${group} ${action}`];

  return why
    ? `--no-email covers a customer's transactional emails only, and ${
      why}. Drop the flag.`
    : null;
};
