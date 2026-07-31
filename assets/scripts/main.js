import { Extensions } from "./extensions/extensions.js";
import { Copyright } from "./copyright/copyright.js";
import { Touchable } from "./touchable/touchable.js";

Extensions.apply();
Copyright.setYear();
Touchable.addTouchedListener();
