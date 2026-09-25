// The account menu's dropdown and the phone menu's offcanvas register
// themselves on import.
import Dropdown from "bootstrap/js/dist/dropdown.js";
import "bootstrap/js/dist/offcanvas.js";

import { Extensions } from "./extensions/extensions.js";
import { wireCartBadge } from "./cart-badge/cart-badge.js";
import { wireMiniCart } from "./cart-badge/mini-cart.js";
import { Copyright } from "./copyright/copyright.js";
import { wireDotLists } from "./dot-list/dot-list.js";
import { wireHeroVideo } from "./hero/hero.js";
import { wireNewsSignup } from "./news/signup.js";
import { wireSearch } from "./search/palette.js";
import { wireVideos } from "./video/video.js";
import { Session } from "./session/session.js";
import { retireTopBar } from "./top-bar/top-bar.js";
import { Touchable } from "./touchable/touchable.js";

Extensions.apply();
Copyright.setYear();
retireTopBar();
// Now, not on DOMContentLoaded: the order page's own bundle runs after
// this one and announces its first count before that event.
wireCartBadge();
wireMiniCart();
Touchable.addTouchedListener();
// The account menu opens on hover where there is a pointer to hover
// with, and stays open under it; a tap still toggles it.
const hoverMenus = () => {
  if (!matchMedia("(hover: hover)").matches) return;

  for (const slot of document.querySelectorAll(".site-account.dropdown")) {
    const button = slot.querySelector("[data-bs-toggle='dropdown']");
    let timer = null;
    let byHover = false;

    if (!button) continue;
    const open = () => button.getAttribute("aria-expanded") === "true";

    slot.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      // Open already, by hover or a click: leave it as it is.
      if (button.hidden || open()) return;
      byHover = true;
      Dropdown.getOrCreateInstance(button).show();
    });
    slot.addEventListener("mouseleave", () => {
      timer = setTimeout(() => {
        // A menu a click opened or kept stays until clicked away.
        if (!byHover) return;
        byHover = false;
        Dropdown.getOrCreateInstance(button).hide();
      }, 160);
    });
    // A click on the button while the hover holds it open would close
    // it; keep it open instead, now for good, until a click closes it.
    // Bootstrap toggles from the document in the capture phase, before
    // the button hears the click, so this listens on the window, which
    // that phase reaches first.
    window.addEventListener("click", (e) => {
      if (!byHover || !open() || !button.contains(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      byHover = false;
    }, true);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  Session.show();
  wireNewsSignup();
  wireDotLists();
  wireVideos();
  wireHeroVideo();
  wireSearch();
  hoverMenus();
});
