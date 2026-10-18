// Nightly at 07:00 UTC (3:00 or 2:00 in the farm's time): the backup
// export (lib/backup.mjs, docs/backup.md). Scheduled functions run on
// the published production deploy only. The run reports on itself:
// backup.failed and the check's /fail when it fails, a success ping
// when it lands, and silence, which the check alarms on, when it
// never runs.

import { nightly } from "./lib/backup.mjs";
import { withLog } from "./lib/log.mjs";
import { stores } from "./lib/store.mjs";

export const handle = async ({
  s = stores(), env = process.env, fetchImpl, mail, now,
} = {}) => {
  const result = await nightly(s, { env, fetchImpl, mail, now });

  // A failure's detail is in the log and the alert, not in the answer.
  const body = result.error ? { error: "The backup failed." } : result;

  return new Response(JSON.stringify(body), {
    status: result.error ? 500 : 200,
    headers: { "Content-Type": "application/json" },
  });
};

export default withLog("backup", () => handle());

export const config = {
  schedule: "0 7 * * *",
};
