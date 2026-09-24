// Farm news by email: the field in the footer and on the news page.
// One request, then "check your email"; the confirmation link lands
// back on /news/ with ?news=, which the line under the field explains.

import { api } from "../utils/api.js";

const LANDED = {
  confirmed: "You're on the list. Thanks!",
  expired: "That link had expired. Enter your email again and we'll send " +
    "a fresh one.",
  invalid: "That link isn't valid any more. Enter your email again and " +
    "we'll send a fresh one.",
};

// Stricter than type="email", which lets "you@farm" through.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// The spinner stays up at least this long, so a quick answer doesn't
// flash it.
const MIN_BUSY_MS = 700;

const say = (note, text, tone) => {
  note.textContent = text;
  note.dataset.tone = tone || "";
};

const wire = (form) => {
  const input = form.querySelector("input[type='email']");
  const note = form.querySelector("[data-news-note]");
  const idle = form.querySelector(".news-signup-idle");
  const busy = form.querySelector(".news-signup-busy");
  let sending = false;

  const setBusy = (on) => {
    sending = on;
    form.dataset.state = on ? "busy" : "";
    idle.setAttribute("aria-hidden", String(on));
    busy.setAttribute("aria-hidden", String(!on));
  };

  const setInvalid = (on) => {
    input.classList.toggle("is-invalid", on);
    input.setAttribute("aria-invalid", String(on));
  };

  input.addEventListener("input", () => {
    if (!input.classList.contains("is-invalid")) return;
    if (!EMAIL.test(input.value.trim())) return;
    setInvalid(false);
    say(note, "");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;

    const email = input.value.trim();

    if (!EMAIL.test(email)) {
      setInvalid(true);
      say(note, email
        ? "Enter a valid email address, like you@example.com."
        : "Enter your email address.", "no");
      input.focus();

      return;
    }

    setInvalid(false);
    say(note, "");
    setBusy(true);

    const [{ ok, data }] = await Promise.all([
      api("/api/news/subscribe", { method: "POST", body: { email } })
        .catch(() => ({ ok: false })),
      new Promise((resolve) => setTimeout(resolve, MIN_BUSY_MS)),
    ]);

    setBusy(false);
    if (ok) {
      say(note, `Check ${email} for an email from us. One click there and ` +
        "you're on the list.", "ok");
      input.value = "";
    } else if (data && data.errors && data.errors.email) {
      setInvalid(true);
      say(note, data.errors.email, "no");
    } else {
      say(note, "That didn't work. Try again in a moment.", "wait");
    }
  });
};

export const wireNewsSignup = () => {
  const forms = [...document.querySelectorAll("[data-news-signup]")];

  if (!forms.length) return;

  for (const form of forms) wire(form);

  const params = new URLSearchParams(location.search);
  const landed = params.get("news");

  if (landed && LANDED[landed]) {
    const note = forms[0].querySelector("[data-news-note]");

    say(note, LANDED[landed], landed === "confirmed" ? "ok" : "wait");
    forms[0].scrollIntoView({ block: "center" });
    params.delete("news");
    history.replaceState(null, "", `${location.pathname}${
      params.toString() ? `?${params}` : ""}`);
  }
};
