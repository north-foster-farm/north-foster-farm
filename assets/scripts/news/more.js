// The news list loads older posts as the reader nears its end. Each
// page of the list is ordinary HTML with a link to the next; this
// fetches that page, takes its year sections and appends them, joining
// a year that runs across the page break, and the Farm news sign-up
// that follows each page's posts. The pager stays hidden while this
// works and comes back if a fetch fails, so the links are always a way
// on.

import { wire } from "./signup.js";

// How far ahead of the end, in pixels, the next page starts loading.
const AHEAD = 800;

export const wireMore = () => {
  const years = document.querySelector("[data-news-years]");
  const pager = document.querySelector("[data-news-pager]");
  const link = pager && pager.querySelector("[data-news-next]");

  if (!years || !link || !("IntersectionObserver" in window)) return;

  let next = link.href;
  let loading = false;

  const status = document.createElement("p");
  const sentinel = document.createElement("div");

  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  sentinel.className = "news-more";
  sentinel.setAttribute("aria-hidden", "true");
  years.after(sentinel, status);
  pager.hidden = true;

  const near = () => sentinel.getBoundingClientRect().top
    < window.innerHeight + AHEAD;

  const append = (doc) => {
    let added = 0;

    for (const section of doc.querySelectorAll(
      "[data-news-years] .news-year")) {
      const last = years.lastElementChild;
      const items = section.querySelectorAll(".news-item");

      added += items.length;
      section.querySelectorAll("[data-news-signup]").forEach(wire);
      if (last && last.dataset.year === section.dataset.year) {
        // The year goes on under its heading: this page's list and
        // sign-up follow the last page's.
        last.append(...section.querySelectorAll(
          ":scope > .news-list, :scope > .news-inline-signup"));
      } else {
        years.append(section);
      }
    }

    return added;
  };

  let observer = null;

  const stop = () => {
    observer.disconnect();
    sentinel.remove();
  };

  const load = async () => {
    if (loading || !next) return;
    loading = true;
    sentinel.dataset.loading = "true";
    try {
      const res = await fetch(next);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const doc = new DOMParser().parseFromString(await res.text(),
        "text/html");
      const added = append(doc);
      const more = doc.querySelector("[data-news-next]");

      next = more ? more.href : null;
      status.textContent = `${added} older ${added === 1
        ? "post" : "posts"} loaded.`;
      if (next) {
        link.href = next;
      } else {
        stop();
      }
    } catch {
      // Fall back to the pager, pointing at the page that failed.
      stop();
      link.href = next;
      pager.hidden = false;
    } finally {
      loading = false;
      delete sentinel.dataset.loading;
    }
    // A short page can leave the end still in view; keep going.
    if (next && near()) load();
  };

  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) load();
  }, { rootMargin: `${AHEAD}px 0px` });
  observer.observe(sentinel);
};
