// The bundle's way to the error reporter (assets/scripts/report.js),
// which the page loads first. Without it nothing is reported and
// nothing breaks.

const reporter = () => {
  try {
    return typeof window.nffReport === "function" ? window.nffReport : null;
  } catch {
    return null;
  }
};

// A failure in a place the customer can still work around: logged.
export const reportError = (where, error) => {
  try {
    const r = reporter();

    if (r) r("error", { where, error });
  } catch {
    // Never the customer's problem.
  }
};

// The page cannot take a payment: an alert.
export const reportUnavailable = (where, error) => {
  try {
    const r = reporter();

    if (r) r("payment.unavailable", { where, error });
  } catch {
    // As above.
  }
};

export const crumb = (name) => {
  try {
    const r = reporter();

    if (r) r.crumb(name);
  } catch {
    // As above.
  }
};

export const sdk = (name, state) => {
  try {
    const r = reporter();

    if (r) r.sdk(name, state);
  } catch {
    // As above.
  }
};
