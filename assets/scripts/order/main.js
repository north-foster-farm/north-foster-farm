// Bootstrap's data API registers itself on import: the category
// drawer needs no glue.
import "bootstrap/js/dist/offcanvas.js";

import { OrderForm } from "./order-form.js";

OrderForm.init();
