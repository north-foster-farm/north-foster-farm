// The tab row's arrows and fades (#579, #591), kept in step with the
// row's scrolling and size: the end's shown while any tab lies past the
// row's end, the start's while any lies before its start, both gone
// once the row fits. Mid-row, both show.

import {
  tabsBack, tabsBackStop, tabsMore, tabsStop,
} from "./lib/tab-scroll.mjs";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const watchTabs = (wrap) => {
  const nav = wrap && wrap.querySelector(".account-nav");
  const more = wrap && wrap.querySelector("[data-tabs-more]");
  const back = wrap && wrap.querySelector("[data-tabs-back]");

  if (!nav || !more || !back) return;

  const tabs = () => Array.from(nav.querySelectorAll(".account-tab"))
    .filter((tab) => !tab.hidden)
    .map((tab) => ({
      left: tab.offsetLeft, right: tab.offsetLeft + tab.offsetWidth,
    }));
  const view = () => ({
    left: nav.scrollLeft, width: nav.clientWidth, full: nav.scrollWidth,
  });

  const sync = () => {
    const now = view();
    const after = tabsMore(now);
    const before = tabsBack(now);

    wrap.toggleAttribute("data-more", after);
    more.hidden = !after;
    wrap.toggleAttribute("data-back", before);
    back.hidden = !before;
  };
  const go = (left) => nav.scrollTo({
    left, behavior: reduced() ? "auto" : "smooth",
  });

  more.addEventListener("click", () => go(tabsStop(tabs(), view())));
  back.addEventListener("click", () => go(tabsBackStop(tabs(), view())));
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
