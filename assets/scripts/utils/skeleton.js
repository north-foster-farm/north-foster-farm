// Loading skeletons (#271): every region that fills in after the page
// loads shows the same pale bars while it waits, drawn by
// partials/skeleton.html and styled in components/_skeleton.scss.
// This sets the region's state; the stylesheet does the rest.
//
// A region is any element holding a skeleton. Its data-load says
// where it stands, and while it loads it is aria-busy:
//
// - "wait": loading, the bars not yet shown. A skeleton in the flow
//   already holds the content's place, unseen, so nothing moves when
//   it appears; one laid over the content leaves the content showing.
// - "shown": the bars are up.
// - "failed": an error, or no answer in time. The region's message
//   and its Try again link show (partials/skeleton/status.html).
//
// With no data-load, the content shows. A skeleton in the flow stands
// in for the content after it; one laid over (skeleton-over) covers
// the box it sits in, so that box keeps its own size throughout.

// A load quicker than this never shows the bars, so it doesn't flash.
export const SHOW_AFTER_MS = 150;
// Once up, the bars stay this long at least, like the busy button.
export const HOLD_MS = 300;
// No skeleton stays up longer than this: the region says it failed.
export const GIVE_UP_MS = 10_000;

const regionsOf = (regions) => (regions && regions.nodeType === 1
  ? [regions]
  : Array.from(regions || []));

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

// The newest load of each region; an older one, overtaken by a retry,
// changes nothing.
const current = new WeakMap();

const settle = (els) => {
  for (const el of els) {
    delete el.dataset.load;
    el.removeAttribute("aria-busy");
  }
};

// Takes a region out of its loading state, whatever it was in: for a
// region that loads again quietly in the background and comes good.
export const clear = (regions) => {
  const els = regionsOf(regions);

  for (const el of els) current.delete(el);
  settle(els);
};

// Puts the regions in their loading state. -> { done, fail }:
// done(render) waits out the minimum, if the bars are up, then runs
// render and shows the content in the same frame; fail(retry) shows
// the regions' message, its link running retry, or reloading the page
// without one.
export const loading = (regions) => {
  const els = regionsOf(regions);
  const view = {};
  let shownAt = 0;

  const mine = () => els.some((el) => current.get(el) === view);

  for (const el of els) {
    current.set(el, view);
    el.dataset.load = "wait";
    el.setAttribute("aria-busy", "true");
  }

  const timer = setTimeout(() => {
    if (!mine()) return;
    shownAt = Date.now();
    for (const el of els) el.dataset.load = "shown";
  }, SHOW_AFTER_MS);

  view.done = async (render) => {
    clearTimeout(timer);
    if (shownAt) await sleep(HOLD_MS - (Date.now() - shownAt));
    if (!mine()) return false;
    if (render) render();
    clear(els);

    return true;
  };

  view.fail = (retry) => {
    clearTimeout(timer);
    if (!mine()) return;
    for (const el of els) {
      el.dataset.load = "failed";
      el.removeAttribute("aria-busy");
      for (const link of el.querySelectorAll("[data-skeleton-retry]")) {
        link.onclick = (event) => {
          event.preventDefault();
          if (retry) retry();
          else location.reload();
        };
      }
    }
  };

  return view;
};

const TIMED_OUT = Symbol("timed out");

// The usual case: runs request() with the regions loading, then
// render(result) as the content takes their place. An error, a result
// failed(result) refuses, or no answer within GIVE_UP_MS shows the
// failure instead. An answer that comes after that still lands, unless
// a retry has started since.
//
// -> the result once rendered, or null if it failed or is late.
export const whileLoading = async (regions, request, {
  render = () => {},
  failed = (result) => result == null || result.ok === false,
  retry,
} = {}) => {
  const view = loading(regions);
  let timer;
  const answer = Promise.resolve().then(request);
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), GIVE_UP_MS);
  });

  let result;

  try {
    result = await Promise.race([answer, late]);
  } catch {
    clearTimeout(timer);
    view.fail(retry);

    return null;
  }
  clearTimeout(timer);

  if (result === TIMED_OUT) {
    view.fail(retry);
    answer.then((r) => {
      if (!failed(r)) view.done(() => render(r));
    }, () => {});

    return null;
  }
  if (failed(result)) {
    view.fail(retry);

    return null;
  }

  return await view.done(() => render(result)) ? result : null;
};
