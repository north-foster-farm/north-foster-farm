// The account menu's dropdown and the phone menu's offcanvas register
// themselves on import.
import "bootstrap/js/dist/dropdown.js";
import "bootstrap/js/dist/offcanvas.js";

import { Extensions } from "./extensions/extensions.js";
import { Copyright } from "./copyright/copyright.js";
import { wireNewsSignup } from "./news/signup.js";
import { Session } from "./session/session.js";
import { Touchable } from "./touchable/touchable.js";

Extensions.apply();
Copyright.setYear();
Touchable.addTouchedListener();
document.addEventListener("DOMContentLoaded", () => {
  Session.show();
  wireNewsSignup();
});
