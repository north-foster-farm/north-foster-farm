// The top bar names the next event until it ends. The build picks the
// event, but no build runs on the day, so the page drops a bar whose
// end has passed, on the site's clock (clock/now.js). Only forward: a
// bar the build left out, or this removed, can't come back.

import { siteNow } from "../clock/now.js";

export const retireTopBar = (root = document, now = siteNow()) => {
  const bar = root.querySelector("[data-top-bar]");

  if (bar && now > Date.parse(bar.dataset.until)) bar.remove();
};
