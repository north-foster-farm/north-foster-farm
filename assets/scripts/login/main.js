// The sign-in page: one email field, one request, then "check your
// email". A ?error= from a bad or used link explains itself here.

import { api } from "../utils/api.js";
import { isBusy, whileBusy } from "../utils/busy-button.js";
import { say } from "../utils/contact-link.js";

const ERRORS = {
  expired: "That sign-in link expired. Ask for a new one below.",
  unknown: "That sign-in link was already used or isn't valid. Ask for " +
    "a new one below.",
  invalid: "That sign-in link isn't valid. Ask for a new one below.",
  // A link to a new email address that could not move the account
  // (#240). "[contact us]" is the support link.
  "change-expired": "That link has expired. Sign in and change your " +
    "email address again from your account settings.",
  "change-taken": "That email address already exists. For additional " +
    "support, [contact us].",
  "change-failed": "We couldn't change your email address. Continue " +
    "using your current email address, or [contact us] for additional " +
    "support.",
};

// A change link's confirm step (#240): #confirm=TOKEN&email=NEW, read
// from the fragment so the token never reaches a server log.
const confirmStep = () => {
  const panel = document.getElementById("login-confirm");

  if (!panel || !location.hash.startsWith("#confirm=")) return null;

  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("confirm");
  const email = params.get("email") || "";

  history.replaceState(null, "", location.pathname + location.search);

  return token ? { panel, token, email } : null;
};

const start = () => {
  const form = document.getElementById("login-form");

  if (!form) return;

  const ask = document.getElementById("login-ask");
  const sent = document.getElementById("login-sent");
  const notice = ask.querySelector("[data-login-notice]");
  const email = form.querySelector("#login-email");
  const error = form.querySelector("[data-error-for='email']");
  const submit = document.getElementById("login-submit");
  const params = new URLSearchParams(location.search);
  const next = params.get("next") || "";
  const reason = params.get("error");

  if (reason && ERRORS[reason]) {
    say(notice, ERRORS[reason]);
    notice.hidden = false;
  }

  const confirm = confirmStep();

  if (confirm) {
    form.hidden = true;

    const { panel, token, email: newEmail } = confirm;
    const panelError = panel.querySelector("[data-confirm-error]");
    const confirmButton = document.getElementById("login-confirm-submit");

    panel.querySelector("[data-confirm-email]").textContent = newEmail;
    panel.hidden = false;

    confirmButton.addEventListener("click", async () => {
      if (isBusy(confirmButton)) return;
      panelError.hidden = true;

      const { data } = await whileBusy(confirmButton, api(
        "/api/auth/verify", { method: "POST", body: { token } }
      ).catch(() => ({ data: null })));

      if (data && data.ok) {
        location.href = data.next || "/account/";

        return;
      }

      say(panelError, (data && ERRORS[data.reason]) || "We couldn't " +
        "change your email address. Please try again later. If the " +
        "problem persists, [contact us] for additional support.");
      panelError.hidden = false;
    });

    document.getElementById("login-confirm-cancel")
      .addEventListener("click", () => {
        panel.hidden = true;
        form.hidden = false;
      });
  }

  const fail = (message) => {
    email.classList.add("is-invalid");
    error.textContent = message;
    email.focus();
  };

  const showSent = () => {
    ask.hidden = true;
    sent.hidden = false;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isBusy(submit)) return;
    email.classList.remove("is-invalid");
    error.textContent = "";

    const value = email.value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      fail("Please enter the email address you order with.");

      return;
    }

    const { ok, data } = await whileBusy(submit, api("/api/auth/request", {
      method: "POST",
      body: {
        email: value,
        next,
        website: form.querySelector("[name='website']").value,
      },
    }));

    if (!ok) {
      fail((data && data.maintenance && data.message)
        || (data && data.errors && data.errors.email)
        ||"We couldn't send a link just now. Please try again.");

      return;
    }

    showSent();
  });

  document.getElementById("login-again").addEventListener("click", () => {
    sent.hidden = true;
    ask.hidden = false;
    email.focus();
  });
};

document.addEventListener("DOMContentLoaded", start);
