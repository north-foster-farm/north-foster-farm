// The sign-in page: one email field, one request, then "check your
// email". A ?error= from a bad or used link explains itself here.

import { api } from "../utils/api.js";

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

  const confirm = confirmStep();

  if (confirm) {
    form.hidden = true;

    const { panel, token, email: newEmail } = confirm;
    const panelError = panel.querySelector("[data-confirm-error]");
    const confirmButton = document.getElementById("login-confirm-submit");

    panel.querySelector("[data-confirm-email]").textContent = newEmail;
    panel.hidden = false;

    confirmButton.addEventListener("click", async () => {
      confirmButton.disabled = true;
      confirmButton.textContent = "Confirming…";
      panelError.hidden = true;

      const { data } = await api("/api/auth/verify", {
        method: "POST",
        body: { token },
      });

      if (data && data.ok) {
        location.href = data.next || "/account/";

        return;
      }

      confirmButton.disabled = false;
      confirmButton.textContent = "Confirm new email";
      panelError.textContent = (data && ERRORS[data.reason])
        || "We couldn't change your email just now. Please try again.";
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
