// The farm's pickup schedule, read from the environment on every
// request (W11d), so a change reaches customers with the next deploy
// and never waits on a rebuilt page. The deploy check
// (bin/check-schedule.mjs) keeps a broken one from shipping; if one
// got through anyway, the windows that parse are still offered and
// the log says what is wrong.

import {
  parseSchedule,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import { log } from "./log.mjs";

export const pickupSchedule = (env = process.env) => {
  const { windows, errors } = parseSchedule(env.PICKUP_SCHEDULE);

  if (errors.length) {
    log.error({ event: "schedule.invalid", errors: errors.slice(0, 5) });
  }

  return windows;
};
