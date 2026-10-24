// The pickup schedule every test runs against (test/setup.mjs sets it
// as PICKUP_SCHEDULE): each weekday of October and November 2026, a
// morning and an afternoon window, like the fixed pair before W11d.
// The generator is development's too (bin/dev-schedule.mjs).

import { scheduleFor } from "../bin/dev-schedule.mjs";

export { AFTERNOON, MORNING } from "../bin/dev-schedule.mjs";

export const SCHEDULE = scheduleFor("2026-10-01", "2026-11-30");

// A test file run alone, without test/setup.mjs, still sees the
// fixture's schedule, never the machine's.
process.env.PICKUP_SCHEDULE = SCHEDULE;
