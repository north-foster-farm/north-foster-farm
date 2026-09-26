// Farm news by email: the field in the footer and on the news page.
// One request puts the address on the list (W1). The old list's
// confirmation link lands back on /news/ with ?news=, which the line
// under the field explains.

import { api } from "../utils/api.js";
import { looksLikeEmail } from "../utils/email.js";
import { isBusy, whileBusy } from "../utils/busy-button.js";

const JOINED = "You're on the list. Thanks!";

const LANDED = {
  confirmed: JOINED,
  expired: "That link had expired. Enter your email here to join.",
  invalid: "That link isn't valid any more. Enter your email here to join.",
};

const say = (note, text, tone) => {
  note.textContent = text;
  note.dataset.tone = tone || "";
};

const wire = (form) => {
  const input = form.querySelector("input[type='email']");
  const note = form.querySelector("[data-news-note]");
  const button = form.querySelector("button");

  const setInvalid = (on) => {
    input.classList.toggle("is-invalid", on);
    input.setAttribute("aria-invalid", String(on));
  };

  input.addEventListener("input", () => {
    if (!input.classList.contains("is-invalid")) return;
    if (!looksLikeEmail(input.value.trim())) return;
    setInvalid(false);
    say(note, "");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isBusy(button)) return;

    const email = input.value.trim();

    if (!looksLikeEmail(email)) {
      setInvalid(true);
      say(note, email
        ? "Enter a valid email address, like you@example.com."
        : "Enter your email address.", "no");
      input.focus();

      return;
    }

    setInvalid(false);
    say(note, "");

    const { ok, data } = await whileBusy(button,
      api("/api/news/subscribe", { method: "POST", body: { email } })
        .catch(() => ({ ok: false })));

    if (ok) {
      say(note, JOINED, "ok");
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
