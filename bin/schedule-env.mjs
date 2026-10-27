// Sets PICKUP_SCHEDULE on Netlify for `bin/nff schedule set` and reads
// it back. On 2026-09-28 a set to the staging branch exited 0 and left
// nothing on any site, and the next staging build failed its schedule
// check; a set that doesn't read back now fails where it's run.
//
// run(args) -> Promise<stdout>, the Netlify CLI; site is the site id
// the CLI was pointed at, for the error.

export const setSchedule = async (run, value, contexts, site) => {
  for (const context of contexts) {
    await run(["env:set", "PICKUP_SCHEDULE", value, "--context", context]);

    const back = String(await run(["env:get", "PICKUP_SCHEDULE",
      "--context", context])).trim();

    if (back !== value) {
      throw new Error(`PICKUP_SCHEDULE didn't take on ${context} of site ${
        site || "(no NETLIFY_SITE_ID)"}: it reads back ${back
        ? `as ${back.length} other characters` : "empty"}.`);
    }
  }
};
