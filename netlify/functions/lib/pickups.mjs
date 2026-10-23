// The farm's pickup schedule, read from the environment on every
// request (W11d), so a change reaches customers with the next deploy
// and never waits on a rebuilt page. The deploy check
// (bin/check-schedule.mjs) keeps a broken one from shipping; if one
// got through anyway, the windows that parse are still offered and
// the log says what is wrong. The array is the on-farm windows; its
// `lines` property holds the lines that decide each occurrence of a
// series (an occurrence with no line is not offered).

import {
  parseSchedule,
} from "../../../assets/scripts/order/lib/schedule.mjs";
import { log } from "./log.mjs";

export const pickupSchedule = (env = process.env) => {
  const { windows, lines, errors } = parseSchedule(env.PICKUP_SCHEDULE);

  if (errors.length) {
    log.error({ event: "schedule.invalid", errors: errors.slice(0, 5) });
  }

  // The lines ride on the array, so every caller that passes the
  // schedule along carries them too.
  return Object.assign(windows, { lines });
};
