// The confirm step of an email-change link (#240, #345): the link
// lands on the account page (or, for a browser with no matching
// session, the sign-in page) with #confirm=TOKEN&email=NEW&from=OLD in
// the fragment, so the token never reaches a server log. Only the
// button's POST spends it.

import { api } from "./api.js";
import { isBusy, whileBusy } from "./busy-button.js";
import { say } from "./contact-link.js";

// Why a change link could not move the account (#240). "[contact us]"
// is the support link.
export const CHANGE_ERRORS = {
  "change-expired": "That link has expired. Sign in and change your " +
    "email address again from your account settings.",
  "change-taken": "That email address already exists. For additional " +
    "support, [contact us].",
  "change-failed": "We couldn't change your email address. Continue " +
    "using your current email address, or [contact us] for additional " +
    "support.",
};

const same = (a, b) => String(a).trim().toLowerCase()
  === String(b).trim().toLowerCase();

// -> { token, email, from } when the fragment holds a confirm step,
// else null. The fragment is dropped at once, replaced by `keep`.
export const readConfirm = (keep = "") => {
  if (!location.hash.startsWith("#confirm=")) return null;

  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("confirm");

  history.replaceState(null, "", location.pathname + location.search + keep);

  return token ? {
    token, email: params.get("email") || "", from: params.get("from") || "",
  } : null;
};

// The fragment the sign-in page reads, for a browser the account page
// cannot confirm in.
export const confirmHash = ({ token, email }) => `#confirm=${
  encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

// True when the link was asked for by the account in this session.
export const isFor = ({ from }, customer) => !from
  || same(from, customer.email);

// Shows the card for `step` and wires its buttons. Confirm moves the
// account and goes to where the server says; Cancel runs `onCancel`.
export const showConfirm = (panel, step, onCancel) => {
  const error = panel.querySelector("[data-confirm-error]");
  const confirm = panel.querySelector(".busy-button");
  const cancel = panel.querySelector("[id$='-confirm-cancel']");

  panel.querySelector("[data-confirm-email]").textContent = step.email;
  panel.hidden = false;
  confirm.addEventListener("click", async () => {
    if (isBusy(confirm)) return;
    error.hidden = true;

    const { data } = await whileBusy(confirm, api(
      "/api/auth/verify", { method: "POST", body: { token: step.token } }
    ).catch(() => ({ data: null })));

    if (data && data.ok) {
      location.href = data.next || "/account/";

      return;
    }

    say(error, (data && CHANGE_ERRORS[data.reason]) || "We couldn't " +
      "change your email address. Please try again later. If the " +
      "problem persists, [contact us] for additional support.");
    error.hidden = false;
  });
  cancel.addEventListener("click", () => {
    panel.hidden = true;
    onCancel();
  });
};
