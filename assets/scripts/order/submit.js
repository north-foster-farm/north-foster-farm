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
//   { kind: "retry" }                    transient, safe to try again
//   { kind: "failed", message }          permanent

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

    if (res.status === 204) return { kind: "ok", data: null };

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
    if (res.status === 503 || res.status === 429 || res.status >= 500) {
      return { kind: "retry" };
    }

    return {
      kind: "failed",
      message: data.message || "Something went wrong placing your order.",
    };
  }
}
