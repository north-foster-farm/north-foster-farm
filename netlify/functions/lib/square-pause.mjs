// The Square deletion kill switch (James, #241 and #236). The
// automatic Square cleanups (the daily sweep's cancelling of the site's
// orders a failed payment left open, and its deleting of the customer
// profiles a failed checkout made) run unless it is set. It is set by
// either of:
//
// - the pause flag (PAUSE_KEY in the jobs store), which
//   `bin/nff square deletions pause|resume` flips. Every run reads it,
//   so it stops the cleanups at once, with no deploy. A flag that
//   cannot be read counts as set: nothing is deleted on a guess.
// - SQUARE_DELETION_KILL_SWITCH, any non-blank value, which takes
//   effect on Netlify at the next deploy and in bin/nff from the env
//   file it reads.
//
// ANY CODE THAT DELETES OR CANCELS RECORDS IN SQUARE ON ITS OWN, NOW
// OR LATER, MUST CHECK deletionsPaused() FIRST. A refund, or a cancel
// or deletion a customer or the farm asks for, is not a cleanup and
// does not.
export const KILL_SWITCH = "SQUARE_DELETION_KILL_SWITCH";
export const PAUSE_KEY = "setting/square-deletions";

export const envPaused = (env = process.env) =>
  String(env[KILL_SWITCH] || "").trim() !== "";

// -> { paused, at, by } as the flag stands, or { paused: true,
// unreadable: true } when the store cannot be read.
export const readPause = async (stores) => {
  try {
    const record = await stores.jobs.get(PAUSE_KEY);

    return {
      paused: !!(record && record.paused === true),
      at: (record && record.at) || null,
      by: (record && record.by) || null,
    };
  } catch {
    return { paused: true, at: null, by: null, unreadable: true };
  }
};

// Sets the flag. -> { changed, paused }.
export const setPause = async (stores, paused, {
  by = "unknown", now = new Date(),
} = {}) => {
  const before = await readPause(stores);

  if (!before.unreadable && before.paused === paused) {
    return { changed: false, paused };
  }
  await stores.jobs.set(PAUSE_KEY, { paused, at: now.toISOString(), by });

  return { changed: true, paused };
};

// -> true when the cleanups must stop: the flag or the env var.
export const deletionsPaused = async (stores, env = process.env) =>
  envPaused(env) || (await readPause(stores)).paused;
