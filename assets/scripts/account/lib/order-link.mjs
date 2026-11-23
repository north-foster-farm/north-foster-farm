// The order an email's link names (#924). netlify.toml sends
// /account/orders/<id>/ on to /account/?order=<id>/, so the page is
// served at its own depth; where no rule runs (a preview, a local
// server) the id is still read off the path. -> the id, or "".
//
// Only a value in the shape of an order id counts (#947): anything
// else reads as no order, so the page never echoes text the farm did
// not write.
import { ORDER_ID } from "../../utils/order-id.mjs";

const PATH = /^\/account\/orders\/([^/]+)\/?$/;

// A malformed escape reads as no order, not a URIError.
const decoded = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
};

const shaped = (value) => (ORDER_ID.test(value) ? value : "");

export const orderFromLink = ({ pathname, search }) => {
  const query = new URLSearchParams(search).get("order");

  // An id holds no slash: what follows one is the splat's trailing
  // slash, or a query a redirect joined badly.
  if (query) return shaped(query.split("/")[0]);

  const found = PATH.exec(pathname);

  return found ? shaped(decoded(found[1])) : "";
};
