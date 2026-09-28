// Whether videos may play on their own, between a signed-in customer's
// account and this browser (#161). Both are "on", "off" or null (never
// chosen). The account's choice wins; an account that never chose
// takes the browser's, such as a guest's press of a video's switch
// before signing in.

// -> { adopt } to take the account's value here, { save } to store the
// browser's on the account, or {} when there is nothing to do.
export const reconcile = (account, browser) => {
  if (account) return account === browser ? {} : { adopt: account };
  if (browser) return { save: browser };

  return {};
};
