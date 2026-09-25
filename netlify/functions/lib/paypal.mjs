// The PayPal seam, for Venmo only. Venmo online is PayPal's: the JS
// SDK shows the Venmo button to a US customer, our server creates the
// PayPal order the button pays, the customer approves it in the Venmo
// app, and our server captures it. The money settles in the farm's
// PayPal Business account; the order itself is recorded on the Square
// order as an external tender (square.mjs), so the dashboard, the
// reports and the refunds keep one shape.
//
// Every call carries a PayPal-Request-Id derived from the submission's
// key and attempt, so a retry returns what was already made.

const HOSTS = {
  live: "https://api-m.paypal.com",
  sandbox: "https://api-m.sandbox.paypal.com",
};

export const SDK_URL = "https://www.paypal.com/sdk/js";

export const paypalEnv = (env = process.env) =>
  (env.PAYPAL_ENV === "live" ? "live" : "sandbox");

export class PayPalError extends Error {
  constructor(message, {
    retryable = false, status = 0, detail = null, declined = false,
    code = null,
  } = {}) {
    super(message);
    this.name = "PayPalError";
    this.retryable = retryable;
    this.status = status;
    this.detail = detail;
    this.declined = declined;
    this.code = code;
  }
}

export const configured = (env = process.env) =>
  !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

export const settings = (env = process.env) => {
  if (!configured(env)) {
    throw new PayPalError("Missing PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET");
  }

  return {
    clientId: env.PAYPAL_CLIENT_ID,
    secret: env.PAYPAL_CLIENT_SECRET,
    host: HOSTS[paypalEnv(env)],
    webhookId: env.PAYPAL_WEBHOOK_ID || "",
  };
};

// What the page needs to load the SDK: public. Null until the client
// id is set, and then the Venmo button simply does not appear.
export const clientConfig = (env = process.env) => (env.PAYPAL_CLIENT_ID
  ? {
    clientId: env.PAYPAL_CLIENT_ID,
    env: paypalEnv(env),
    sdkUrl: `${SDK_URL}?${new URLSearchParams({
      "client-id": env.PAYPAL_CLIENT_ID,
      currency: "USD",
      intent: "capture",
      components: "buttons",
      "enable-funding": "venmo",
      "disable-funding": "paylater,card,credit",
      ...(paypalEnv(env) === "sandbox" ? { "buyer-country": "US" } : {}),
    })}`,
  }
  : null);

// What the customer reads when Venmo would not pay.
export const DECLINE_MESSAGES = {
  INSTRUMENT_DECLINED: "Venmo declined the payment. Try again, or pay " +
    "another way.",
  PAYER_ACTION_REQUIRED: "Venmo needs you to finish approving the " +
    "payment. Try again.",
  ORDER_NOT_APPROVED: "The Venmo payment wasn't approved. Try again.",
  PAYER_CANNOT_PAY: "Venmo can't take this payment. Pay another way.",
  TRANSACTION_REFUSED: "Venmo declined the payment. Pay another way.",
  COMPLIANCE_VIOLATION: "Venmo declined the payment. Pay another way.",
  MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED: "Too many tries. Pay another " +
    "way.",
};

// A bearer token, kept for its lifetime. One per process; a function
// instance serves many requests before it is recycled.
const tokens = new Map();

const token = async (cfg, fetchImpl, now) => {
  const cached = tokens.get(cfg.clientId);

  if (cached && cached.expiresAt > now.getTime() + 60_000) {
    return cached.value;
  }

  let res;

  try {
    res = await fetchImpl(`${cfg.host}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(
          `${cfg.clientId}:${cfg.secret}`
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
  } catch (error) {
    throw new PayPalError("Network error getting a PayPal token", {
      retryable: true, detail: String(error),
    });
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    throw new PayPalError(`PayPal ${res.status} on /v1/oauth2/token`, {
      retryable: res.status >= 500, status: res.status, detail: data,
    });
  }

  tokens.set(cfg.clientId, {
    value: data.access_token,
    expiresAt: now.getTime() + (Number(data.expires_in) || 0) * 1000,
  });

  return data.access_token;
};

export const forgetTokens = () => tokens.clear();

const call = async (cfg, path, body, {
  fetchImpl, now, requestId, method = "POST",
}) => {
  const bearer = await token(cfg, fetchImpl, now);
  let res;

  try {
    res = await fetchImpl(`${cfg.host}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
  } catch (error) {
    throw new PayPalError(`Network error calling ${path}`, {
      retryable: true, detail: String(error),
    });
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const issue = Array.isArray(data.details) && data.details[0];
    const code = (issue && issue.issue) || data.name || null;

    throw new PayPalError(`PayPal ${res.status} on ${path}`, {
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
      detail: data,
      declined: !!(code && DECLINE_MESSAGES[code]),
      code,
    });
  }

  return data;
};

const value = (cents) => (cents / 100).toFixed(2);

// The order the Venmo button will pay. `custom_id` carries our order
// id so a webhook can find the checkout it belongs to.
// -> { paypalOrderId }
export const createOrder = async (order, key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) => {
  const cfg = settings(env);
  const data = await call(cfg, "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: order.id,
      custom_id: order.id,
      description: `North Foster Farm order ${order.id}`.slice(0, 127),
      amount: { currency_code: "USD", value: value(order.totals.total) },
    }],
    application_context: {
      brand_name: "North Foster Farm",
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
    },
  }, { fetchImpl, now, requestId: `${key}-create` });

  if (!data.id) {
    throw new PayPalError("PayPal returned no order id", { detail: data });
  }

  return { paypalOrderId: data.id };
};

const captureOf = (data) => {
  const unit = (data.purchase_units || [])[0] || {};
  const capture = ((unit.payments || {}).captures || [])[0] || null;
  const payer = data.payer || {};
  const name = payer.name || {};

  return capture
    ? {
      paypalOrderId: data.id,
      paypalCaptureId: capture.id,
      status: capture.status,
      amount: capture.amount
        ? Math.round(Number(capture.amount.value) * 100)
        : null,
      payer: {
        email: payer.email_address || null,
        name: [name.given_name, name.surname].filter(Boolean).join(" ")
          || null,
      },
    }
    : null;
};

export const getOrder = async (paypalOrderId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) => {
  const cfg = settings(env);
  const data = await call(
    cfg, `/v2/checkout/orders/${paypalOrderId}`, null,
    { fetchImpl, now, method: "GET" }
  );

  return {
    status: data.status,
    updatedAt: data.update_time || data.create_time || null,
    capture: captureOf(data),
  };
};

// Takes the money the customer approved. An order already captured
// (a retry, or a webhook that got there first) is read back instead
// of failing.
// -> { paypalOrderId, paypalCaptureId, status, amount, payer }
// throws PayPalError { declined, code } when Venmo would not pay.
export const captureOrder = async (paypalOrderId, key, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) => {
  const cfg = settings(env);
  let data;

  try {
    data = await call(cfg, `/v2/checkout/orders/${paypalOrderId}/capture`,
      {}, { fetchImpl, now, requestId: `${key}-capture` });
  } catch (error) {
    if (error.code !== "ORDER_ALREADY_CAPTURED") throw error;

    const current = await getOrder(paypalOrderId, { env, fetchImpl, now });

    if (!current.capture) throw error;

    return current.capture;
  }

  const capture = captureOf(data);

  if (!capture || capture.status !== "COMPLETED") {
    throw new PayPalError(`Capture ${capture ? capture.status : "missing"}`, {
      declined: true,
      code: capture ? capture.status : "NO_CAPTURE",
      detail: data,
    });
  }

  return capture;
};

// Money back on a capture, whole or part. Venmo tells the customer.
// -> { paypalRefundId, status, amount }
export const refundCapture = async ({
  paypalCaptureId, amount, key, note,
}, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) => {
  const cfg = settings(env);
  const data = await call(cfg,
    `/v2/payments/captures/${paypalCaptureId}/refund`, {
      amount: { currency_code: "USD", value: value(amount) },
      note_to_payer: note ? String(note).slice(0, 255) : undefined,
    }, { fetchImpl, now, requestId: `${key}-refund` });

  return {
    paypalRefundId: data.id,
    status: data.status,
    amount: data.amount ? Math.round(Number(data.amount.value) * 100) : amount,
  };
};

// PayPal signs each webhook delivery; the verification is a call back
// to PayPal with the headers and the body as received. -> true/false.
export const verifyWebhook = async (headers, body, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) => {
  const cfg = settings(env);

  if (!cfg.webhookId) return false;

  const get = (name) => headers.get(name) || "";
  let event;

  try {
    event = JSON.parse(body);
  } catch {
    return false;
  }

  const data = await call(cfg, "/v1/notifications/verify-webhook-signature", {
    auth_algo: get("paypal-auth-algo"),
    cert_url: get("paypal-cert-url"),
    transmission_id: get("paypal-transmission-id"),
    transmission_sig: get("paypal-transmission-sig"),
    transmission_time: get("paypal-transmission-time"),
    webhook_id: cfg.webhookId,
    webhook_event: event,
  }, { fetchImpl, now });

  return data.verification_status === "SUCCESS";
};
