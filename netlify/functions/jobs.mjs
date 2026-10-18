// Every 15 minutes: remind tomorrow's deliveries, close fulfilled
// orders, retry a Venmo order's Square copy, finish a Venmo payment
// the page never did, drop unfinished Venmo checkouts and expired
// sign-ins, send the daily reports. Every order is paid when it is
// recorded, so nothing here chases money. All decisions come from the
// records and the wall clock in America/New_York, so the schedule's
// UTC minute does not matter and a repeat run sends nothing twice.
//
// The run reports on itself (lib/jobs.mjs: errors, invariants, the
// ledger, the heartbeat). A run that throws before it can is the one
// failure the run cannot report, so it is caught here and alerted as
// jobs.crashed, and the heartbeat is told.

import { alert, ping } from "./lib/health.mjs";
import { runJobs } from "./lib/jobs.mjs";
import { log, withLog } from "./lib/log.mjs";
import { stores } from "./lib/store.mjs";

const answer = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

// It answers 500 rather than throwing, so withLog does not alert the
// same crash a second time as function.crashed.
export const handle = async ({
  s = stores(), run = runJobs, env = process.env, mail, fetchImpl,
} = {}) => {
  try {
    return answer(200, await run(s));
  } catch (error) {
    const message = String((error && error.message) || error);

    log.error({ event: "jobs.crashed", error: message, stack: error.stack });
    await alert(s, "jobs.crashed", { error: message },
      { env, mail, fetchImpl });
    await ping(env.HEALTHCHECKS_JOBS_URL, {
      ok: false, body: { crashed: message }, fetchImpl,
    });

    // The detail is in the log and the alert; the answer carries none.
    return answer(500, { error: "The scheduled run failed." });
  }
};

export default withLog("jobs", () => handle());

export const config = {
  schedule: "*/15 * * * *",
};
