// Farm news by email: the field in the footer and on the news page.
// One request, then "check your email"; the confirmation link lands
// back on /news/ with ?news=, which the note under the field explains.

import { api } from "../utils/api.js";

const LANDED = {
  confirmed: "You're on the list. Thanks!",
  expired: "That link had expired. Enter your email again and we'll send " +
    "a fresh one.",
  invalid: "That link isn't valid any more. Enter your email again and " +
    "we'll send a fresh one.",
};

const say = (note, text, tone) => {
  note.textContent = text;
  note.dataset.tone = tone || "";
};

const wire = (form) => {
  const input = form.querySelector("input[type='email']");
  const button = form.querySelector("button");
  const note = form.querySelector("[data-news-note]");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = input.value.trim();

    if (!email || !input.checkValidity()) {
      say(note, "Please enter your email address.", "wait");
      input.focus();

      return;
    }

    button.disabled = true;
    say(note, "Sending…", "");

    const { ok, data } = await api("/api/news/subscribe", {
      method: "POST", body: { email },
    });

    button.disabled = false;
    if (ok) {
      say(note, `Check ${email} for an email from us. One click there and ` +
        "you're on the list.", "ok");
      input.value = "";
    } else {
      say(note, (data && data.errors && data.errors.email)
        || "That didn't work. Try again in a moment.", "wait");
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
