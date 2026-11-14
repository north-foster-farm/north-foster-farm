// The tab row's arrow and fade (#579), kept in step with the row's
// scrolling and size: shown while any tab lies past the row's end,
// gone once the row fits or is scrolled to its end.

import { tabsMore, tabsStop } from "./lib/tab-scroll.mjs";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const watchTabs = (wrap) => {
  const nav = wrap && wrap.querySelector(".account-nav");
  const more = wrap && wrap.querySelector("[data-tabs-more]");

  if (!nav || !more) return;

  const tabs = () => Array.from(nav.querySelectorAll(".account-tab"))
    .filter((tab) => !tab.hidden)
    .map((tab) => ({
      left: tab.offsetLeft, right: tab.offsetLeft + tab.offsetWidth,
    }));
  const view = () => ({
    left: nav.scrollLeft, width: nav.clientWidth, full: nav.scrollWidth,
  });

  const sync = () => {
    const shown = tabsMore(view());

    wrap.toggleAttribute("data-more", shown);
    more.hidden = !shown;
  };

  more.addEventListener("click", () => {
    nav.scrollTo({
      left: tabsStop(tabs(), view()), behavior: reduced() ? "auto" : "smooth",
    });
  });
  nav.addEventListener("scroll", sync, { passive: true });

  // The row and each tab: a tab that shows (Membership) or turns bold
  // changes the row's width without changing the row's own box. A
  // frame later, as the cart does, so no change lands inside the
  // observer.
  const sizes = new ResizeObserver(() => requestAnimationFrame(sync));

  sizes.observe(nav);
  for (const tab of nav.querySelectorAll(".account-tab")) sizes.observe(tab);
  sync();
};
