// eslint-disable-next-line
import { Collapse } from "bootstrap/dist/js/bootstrap.esm.min.js";

import { Extensions } from "./extensions/extensions.js";
import { Copyright } from "./copyright/copyright.js";
import { Touchable } from "./touchable/touchable.js";

Extensions.apply();
Copyright.setYear();
Touchable.addTouchedListener();
