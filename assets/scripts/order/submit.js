// Sends an order and turns every outcome into one of a few shapes the
// form knows how to handle:
//
//   { kind: "ok", data }                 paid, or Venmo's first step
//   { kind: "declined", code, message }  the processor said no
//   { kind: "checkout", message }        the payment and the order
//                                        disagree; start that payment
//                                        again
//   { kind: "invalid", errors, stock }   fix and resubmit
//   { kind: "stale", dates }             date closed, fresh list attached
//   { kind: "busy", message }            too many tries from here;
//                                        wait, then try again
//   { kind: "retry" }                    transient, safe to try again
//   { kind: "failed", message }          permanent
//
// Only 503 and a lost connection are transient. A 502 is permanent,
// as the server says, and so is any other 5xx. An empty 204 is what
// the server gives a bot; a customer who gets one was not served, so
// it is never taken for success.

export class Submitter {
  async send(payload) {
    let res;

    try {
      res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      return { kind: "retry" };
    }

    if (res.status === 204) {
      return {
        kind: "failed", message: "Something went wrong placing your order.",
      };
    }

    const data = await res.json().catch(() => ({}));

    if (res.ok) return { kind: "ok", data };
    if (res.status === 402) {
      return {
        kind: "declined",
        code: data.code || null,
        message: data.message || "The payment didn't go through.",
      };
    }
    if (res.status === 409 && data.errors && data.errors.payment) {
      return { kind: "checkout", message: data.errors.payment };
    }
    if (res.status === 409) return { kind: "stale", dates: data.dates || [] };
    if (res.status === 422 || res.status === 400) {
      // A stock refusal carries the fresh availability with it.
      return { kind: "invalid", errors: data.errors || {}, stock: data.stock };
    }
    if (res.status === 429) {
      return {
        kind: "busy",
        message: data.message || "There have been too many tries from " +
          "here. Wait a few minutes and try again; your order is saved on " +
          "this page.",
      };
    }
    if (res.status === 503 || data.retryable === true) {
      return { kind: "retry" };
    }

    return {
      kind: "failed",
      message: data.message || "Something went wrong placing your order.",
    };
  }
}
