// Every 15 minutes: poll unpaid invoices, send the reminders that are
// due, abandon what is unpaid at the cutoff, remind tomorrow's
// deliveries, close fulfilled orders. All decisions come from the
// records and the wall clock in America/New_York, so the schedule's
// UTC minute does not matter and a repeat run sends nothing twice.

import { runJobs } from "./lib/jobs.mjs";
import { stores } from "./lib/store.mjs";

export default async () => {
  const report = await runJobs(stores());

  console.info(JSON.stringify({ event: "jobs.run", ...report }));

  return new Response(JSON.stringify(report), {
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  schedule: "*/15 * * * *",
};
