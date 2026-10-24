// Bootstrap's data API registers itself on import: the cart's
// breakdown toggle and the category drawer need no glue.
import "bootstrap/js/dist/collapse.js";
import "bootstrap/js/dist/offcanvas.js";

import { OrderForm } from "./order-form.js";

OrderForm.init();
