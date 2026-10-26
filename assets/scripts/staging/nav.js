// The toolbar's sidebar (#303): Bootstrap's scrollspy marks the
// section in view, its links scroll the pane, and where the sidebar
// would wrap it is a flyout behind the header's menu button
// (staging.css says when). Sections whose areas the session cannot
// open are hidden, with their links.

import ScrollSpy from "bootstrap/js/dist/scrollspy.js";

export const mountNav = ({ root, onSection = () => {} }) => {
  const panel = root.querySelector("[data-staging-panel]");
  const pane = root.querySelector("[data-staging-pane]");
  const nav = root.querySelector("[data-staging-nav]");
  const toggle = root.querySelector("[data-staging-nav-toggle]");
  const links = [...nav.querySelectorAll("a[href^='#']")];
  let spy = null;
  // A timer while a link's jump scrolls the pane.
  let jumping = null;

  const flyout = (open) => {
    panel.classList.toggle("staging-nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };

  const still = () => window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  // The section in view, by its id.
  const current = () => {
    const on = nav.querySelector(".active");

    return on ? on.hash.slice(1) : "";
  };

  // Hides each section, and its link, when none of the areas it names
  // is open to this session.
  const scope = (allowed) => {
    for (const el of root.querySelectorAll("[data-staging-section]")) {
      el.hidden = !el.dataset.stagingSection.split(" ").some(allowed);
    }
    if (spy) spy.refresh();
  };

  // Scrollspy reads where the sections are, so it starts once the pane
  // shows, and reads again on each later showing.
  const shown = () => {
    if (spy) {
      spy.refresh();
    } else {
      // A section counts once it reaches the pane's top fifth, so the
      // first is current at the top and not the next one below it.
      spy = new ScrollSpy(pane, {
        target: nav, rootMargin: "0px 0px -80%", threshold: [0],
      });
      pane.addEventListener("activate.bs.scrollspy", () => {
        if (!jumping) onSection(current());
      });
    }
    onSection(current());
  };

  for (const a of links) {
    a.addEventListener("click", (ev) => {
      const section = pane.querySelector(a.hash);

      ev.preventDefault();
      flyout(false);
      if (!section) return;
      // The sections a jump passes are not the reader's; only where it
      // lands counts (the Email badge clears on it).
      clearTimeout(jumping);
      jumping = setTimeout(() => { jumping = null; }, 1000);
      pane.scrollTo({
        top: section.offsetTop - pane.offsetTop,
        behavior: still() ? "auto" : "smooth",
      });
      // Focus follows the reader to the section (tabindex -1), not to
      // the page, the closed flyout's link being hidden.
      section.focus({ preventScroll: true });
      onSection(a.hash.slice(1));
    });
  }
  toggle.addEventListener("click", () => {
    const open = !panel.classList.contains("staging-nav-open");

    flyout(open);
    if (open) (nav.querySelector(".active") || links[0]).focus();
  });
  // Escape closes an open list from anywhere in the panel, the menu
  // button included, and hands focus back to the button.
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && panel.classList.contains("staging-nav-open")) {
      ev.stopPropagation();
      flyout(false);
      toggle.focus();
    }
  });

  return { scope, shown, current };
};
