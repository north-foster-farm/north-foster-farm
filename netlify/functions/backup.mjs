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

  // A failure's detail is in the log (scrubbed there) and the alert,
  // never in the answer. The answer is built from named fields only,
  // so nothing nightly adds to its result later can reach it (#564).
  const failed = Boolean(result.error);
  let body = { error: "The backup failed." };

  if (!failed) {
    body = result.skipped ? { skipped: true } : {
      key: result.key, bytes: result.bytes, counts: result.counts,
    };
  }

  return new Response(JSON.stringify(body), {
    status: failed ? 500 : 200,
    headers: { "Content-Type": "application/json" },
  });
};

export default withLog("backup", () => handle());

export const config = {
  schedule: "0 7 * * *",
};
