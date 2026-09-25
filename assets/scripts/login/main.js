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

    showSent("login", value);
  });

  // "Find my order": the same request with an order number, so the
  // link lands on that order.
  const find = document.getElementById("find-form");
  const findOrder = find.querySelector("#find-order");
  const findEmail = find.querySelector("#find-email");
  const findSubmit = document.getElementById("find-submit");
  const findFail = (field, key, message) => {
    field.classList.add("is-invalid");
    find.querySelector(`[data-error-for='${key}']`).textContent = message;
    field.focus();
  };
  const showSent = (kind, address) => {
    for (const p of sent.querySelectorAll("[data-sent-for]")) {
      p.hidden = p.dataset.sentFor !== kind;
    }
    sent.querySelector(kind === "find" ? "[data-find-email]"
      : "[data-login-email]").textContent = address;
    form.hidden = true;
    find.hidden = true;
    sent.hidden = false;
  };

  find.addEventListener("submit", async (e) => {
    e.preventDefault();
    for (const field of [findOrder, findEmail]) {
      field.classList.remove("is-invalid");
    }
    for (const slot of find.querySelectorAll("[data-error-for]")) {
      slot.textContent = "";
    }

    const orderId = findOrder.value.trim().toUpperCase();
    const address = findEmail.value.trim();

    // Checked in the order the fields appear.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
      findFail(findEmail, "email", "Please enter the email address you " +
        "ordered with.");

      return;
    }
    if (!/^[A-Z0-9-]{6,32}$/.test(orderId)) {
      findFail(findOrder, "orderId", "Please enter the order number from " +
        "your email, like NFF-2610-K3WM.");

      return;
    }

    findSubmit.disabled = true;
    findSubmit.textContent = "Sending…";

    const { ok, data } = await api("/api/auth/request", {
      method: "POST",
      body: {
        email: address,
        orderId,
        website: find.querySelector("[name='website']").value,
      },
    });

    findSubmit.disabled = false;
    findSubmit.textContent = "Email me a link";

    if (!ok) {
      findFail(findEmail, "email", (data && data.errors && data.errors.email)
        || "We couldn't send a link just now. Please try again.");

      return;
    }

    showSent("find", address);
  });

  document.getElementById("login-again").addEventListener("click", () => {
    sent.hidden = true;
    form.hidden = false;
    find.hidden = false;
    email.focus();
  });
};

document.addEventListener("DOMContentLoaded", start);
