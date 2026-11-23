// PayPal's shapes: the error the seam throws and its answers read into
// ours, with no call in them (#925 phase 1, #964). paypal.mjs, the
// seam, re-exports each, and fake-paypal.mjs takes them from here, so
// the fake no longer imports the driver that hands it each call.

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

// PayPal's answers, read into ours. Exported for fake-paypal.mjs, which
// reads its recordings of PayPal through the same code (#708).

// A captured order -> { paypalOrderId, paypalCaptureId, status, amount,
// payer }, or null when it holds no capture.
export const captureOf = (data) => {
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

// An order read -> { status, updatedAt, capture }.
export const orderOf = (data) => ({
  status: data.status,
  updatedAt: data.update_time || data.create_time || null,
  capture: captureOf(data),
});

// A refund made or read -> { paypalRefundId, status, amount }, the
// amount asked for when PayPal's answer gives none.
export const refundOf = (data, asked) => ({
  paypalRefundId: data.id,
  status: data.status,
  amount: data.amount ? Math.round(Number(data.amount.value) * 100) : asked,
});
