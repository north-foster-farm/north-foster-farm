// The sign-in page: one email field, one request, then "check your
// email". A ?error= from a bad or used link explains itself here.

import { api } from "../utils/api.js";

const ERRORS = {
  expired: "That sign-in link expired. Ask for a new one below.",
  unknown: "That sign-in link was already used or isn't valid. Ask for " +
    "a new one below.",
  invalid: "That sign-in link isn't valid. Ask for a new one below.",
};

const start = () => {
  const form = document.getElementById("login-form");

  if (!form) return;

  const sent = document.getElementById("login-sent");
  const notice = form.querySelector("[data-login-notice]");
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

  const showSent = (address) => {
    sent.querySelector("[data-login-email]").textContent = address;
    form.hidden = true;
    sent.hidden = false;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    email.classList.remove("is-invalid");
    error.textContent = "";

    const value = email.value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      fail("Please enter the email address you order with.");

      return;
    }

    submit.disabled = true;
    submit.textContent = "Sending…";

    const { ok, data } = await api("/api/auth/request", {
      method: "POST",
      body: {
        email: value,
        next,
        website: form.querySelector("[name='website']").value,
      },
    });

    submit.disabled = false;
    submit.textContent = "Email me a sign-in link";

    if (!ok) {
      fail((data && data.errors && data.errors.email)
        || "We couldn't send a link just now. Please try again.");

      return;
    }

    showSent(value);
  });

  document.getElementById("login-again").addEventListener("click", () => {
    sent.hidden = true;
    form.hidden = false;
    email.focus();
  });
};

document.addEventListener("DOMContentLoaded", start);
