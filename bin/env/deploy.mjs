// What `bin/nff env push` does once the values are set: nothing set
// reaches the site until a deploy, so it offers one (#267). It asks
// "Deploy <context> now? [Y/n]", or goes ahead on --allow-deploy, by
// POSTing the context's build hook (PICKUP_SCHEDULE_HOOK in its env
// file). With no hook, no terminal to ask on, or an answer of no, it
// ends on a plain "not live until deployed" line. Names only: the
// hook is a secret URL and is never printed.

const NOT_LIVE = (context) => `NOT LIVE YET: the ${context} site keeps ` +
  "running on its old values until it is deployed.";

// -> the lines to print; throws, without the hook, when the hook fails.
export const deployAfterPush = async ({
  context, hook, allow = false, ask = null, fetchImpl = fetch,
}) => {
  if (!hook) {
    return [NOT_LIVE(context), "No PICKUP_SCHEDULE_HOOK in the env file: " +
      "deploy in Netlify (Deploys, Trigger deploy)."];
  }

  const yes = allow || (ask
    ? !/^n/i.test((await ask(`Deploy ${context} now? [Y/n] `)).trim())
    : false);

  if (!yes) {
    return [NOT_LIVE(context), ask
      ? `Deploy it with: bin/nff env push --${context} --allow-deploy, or ` +
        "in Netlify."
      : "No terminal to ask on. Pass --allow-deploy to deploy from here, " +
        "or deploy in Netlify."];
  }

  const res = await fetchImpl(hook, { method: "POST" }).catch(() => null);

  if (!res || !res.ok) {
    throw new Error(`The ${context} build hook ${res
      ? `answered ${res.status}` : "did not answer"}. ${NOT_LIVE(context)}`);
  }

  return [`Deploy of ${context} started. A build that fails env check ` +
    "leaves the last good deploy live."];
};
