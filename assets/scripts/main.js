// The account menu's dropdown and the phone menu's offcanvas register
// themselves on import.
import Dropdown from "bootstrap/js/dist/dropdown.js";
import "bootstrap/js/dist/offcanvas.js";

import { Extensions } from "./extensions/extensions.js";
import { Copyright } from "./copyright/copyright.js";
import { wireNewsSignup } from "./news/signup.js";
import { Session } from "./session/session.js";
import { Touchable } from "./touchable/touchable.js";

Extensions.apply();
Copyright.setYear();
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
    slot.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      if (button.hidden) return;
      byHover = true;
      Dropdown.getOrCreateInstance(button).show();
    });
    slot.addEventListener("mouseleave", () => {
      timer = setTimeout(() => {
        byHover = false;
        Dropdown.getOrCreateInstance(button).hide();
      }, 160);
    });
    // A click on the button while the hover holds it open would close
    // it; keep it open instead.
    button.addEventListener("click", (e) => {
      if (byHover && button.getAttribute("aria-expanded") === "true") {
        e.stopPropagation();
        e.preventDefault();
      }
    });
  }
};

document.addEventListener("DOMContentLoaded", () => {
  Session.show();
  wireNewsSignup();
  hoverMenus();
});
