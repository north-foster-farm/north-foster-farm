// The Venmo button's two choices (docs/refactors/pay.md, phase 1).
// Pure: order/pay.js wires PayPal's callbacks to them.

// Whether a press opens the sheet. A locked or busy button refuses
// before the form is asked, since prepare() shows the form's errors.
export const clickAllowed = ({ locked, busy }, prepare) => !locked && !busy
  && !!prepare();

// Venmo refused the funding source the buyer picked (#721): the sheet
// opens again on the same PayPal order, once, so they can pick
// another, as PayPal advises. A second decline, or any other failure,
// stops there.
export const shouldRestart = ({ restarted, outcome, actions }) => !restarted
  && !!outcome && outcome.kind === "declined"
  && outcome.code === "INSTRUMENT_DECLINED" && !!actions
  && typeof actions.restart === "function";
