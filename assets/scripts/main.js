// The account menu's dropdown registers itself on import.
import "bootstrap/js/dist/dropdown.js";

import { Extensions } from "./extensions/extensions.js";
import { Copyright } from "./copyright/copyright.js";
import { Session } from "./session/session.js";
import { Touchable } from "./touchable/touchable.js";

Extensions.apply();
Copyright.setYear();
Touchable.addTouchedListener();
document.addEventListener("DOMContentLoaded", () => Session.show());
