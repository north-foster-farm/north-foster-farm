// GET /api/checkout/config: what the order page needs to load the
// payment SDKs. Public values only, per deploy context: the Square
// application id and location for the Web Payments SDK, the PayPal
// client id for the Venmo button. A processor that is not configured
// is null, and the page leaves its buttons out.

import { json } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { clientConfig as paypalConfig } from "./lib/paypal.mjs";
import { clientConfig as squareConfig } from "./lib/square.mjs";

export const handle = async (req, { env = process.env } = {}) => json(200, {
  square: squareConfig(env),
  paypal: paypalConfig(env),
});

export default withLog(async (req) => handle(req));

export const config = {
  path: "/api/checkout/config",
  method: "GET",
};
