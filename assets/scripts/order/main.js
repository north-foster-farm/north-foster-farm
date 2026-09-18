// Bootstrap's data API registers itself on import: the cart's
// breakdown toggle, the category drawer and the sidebar's scrollspy
// need no glue.
import "bootstrap/js/dist/collapse.js";
import "bootstrap/js/dist/offcanvas.js";
import "bootstrap/js/dist/scrollspy.js";

import { OrderForm } from "./order-form.js";

OrderForm.init();
