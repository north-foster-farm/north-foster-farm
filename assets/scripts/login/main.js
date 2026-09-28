// The sign-in page: one email field, one request, then "check your
// email". A ?error= from a bad or used link explains itself here.

import { api } from "../utils/api.js";
import { isBusy, whileBusy } from "../utils/busy-button.js";

const ERRORS = {
  expired: "That sign-in link expired. Ask for a new one below.",
  unknown: "That sign-in link was already used or isn't valid. Ask for " +
    "a new one below.",
  invalid: "That sign-in link isn't valid. Ask for a new one below.",
  // A link to a new address that could not move the account (#240).
  // Drafts.
  "change-taken": "That address has an account of its own now, so " +
    "your email wasn't changed. Sign in with your old address, or " +
    "write us and we'll sort it out.",
  "change-failed": "We couldn't change your email just now. Sign in " +
    "with your old address and try again, or write us.",
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
    notice.textContent = ERRORS[reason];
    notice.hidden = false;
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
