// Farm news by email: the field in the footer and on the news page.
// Anyone can type any address here, so a request mails a confirmation
// link, and only its click puts the address on the list (#303). The
// click lands back on /news/ with ?news=, which the line under the
// field explains. The welcome email's unsubscribe link
// lands with ?unsubscribe=<token>, posted from here so that a mail
// scanner fetching the link takes no one off (T6c).

import { api } from "../utils/api.js";
import { looksLikeEmail } from "../utils/email.js";
import { fieldError } from "../utils/field-errors.mjs";
import { isBusy, whileBusy } from "../utils/busy-button.js";
import { celebrate } from "../order/celebrate.js";
import { forget } from "../session/session.js";
import { forgetJoined, remember, wireNewsHiding } from "./hide.js";

const JOINED = "You're on the list. Thanks!";
// Draft, to approve (#303).
const SENT = "Check your email: click the link we sent you to join.";

const LANDED = {
  confirmed: JOINED,
  expired: "That link has expired. Enter your email address here to join.",
  invalid: "That link was already used or isn't valid. If you haven't " +
    "joined yet, enter your email address here.",
};

// Drafts, to approve.
const LEFT = "You're off the list. We won't send you Farm News.";
const NOT_LEFT = "That unsubscribe link isn't valid. Reply to any of our " +
  "emails and we'll take you off.";

const say = (note, text, tone) => {
  note.textContent = text;
  note.dataset.tone = tone || "";
};

export const wire = (form) => {
  const input = form.querySelector("input[type='email']");
  const note = form.querySelector("[data-farm-list-note]");
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
      say(note, fieldError("email", email), "no");
      input.focus();

      return;
    }

    setInvalid(false);
    say(note, "");

    const { ok, data } = await whileBusy(button,
      api("/api/news/subscribe", { method: "POST", body: { email } })
        .catch(() => ({ ok: false })));

    // Not on the list until the click, so the forms stay: the
    // confirmed landing remembers the sign-up.
    if (ok) {
      say(note, SENT, "ok");
      input.value = "";
      celebrate(button);
    } else if (data && data.maintenance) {
      say(note, data.message, "wait");
    } else if (data && data.errors && data.errors.email) {
      setInvalid(true);
      say(note, data.errors.email, "no");
    } else {
      say(note, "Something went wrong. Please try again.", "wait");
    }
  });
};

// A post's "Sign up for news like this." (#483) scrolls to the footer's
// form and puts the cursor in its field. Without the script the link's
// own hash still takes the reader there.
const wireJump = (link) => {
  link.addEventListener("click", (event) => {
    const field = document.getElementById(link.hash.slice(1));

    if (!field) return;

    event.preventDefault();
    field.closest("form").scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    field.focus({ preventScroll: true });
  });
};

export const wireFarmList = () => {
  const forms = [...document.querySelectorAll("[data-farm-list-form]")];

  if (!forms.length) return;

  for (const form of forms) wire(form);
  document.querySelectorAll("[data-farm-list-jump]").forEach(wireJump);

  const params = new URLSearchParams(location.search);
  const landed = params.get("news");
  const token = params.get("unsubscribe");
  const note = forms[0].querySelector("[data-farm-list-note]");
  const clean = (name) => {
    forms[0].scrollIntoView({ block: "center" });
    params.delete(name);
    history.replaceState(null, "", `${location.pathname}${
      params.toString() ? `?${params}` : ""}`);
  };

  // A page opened from an email link keeps its forms, so the answer
  // under the field is seen; the next page hides them as usual.
  if (!(landed && LANDED[landed]) && !token) wireNewsHiding();

  if (landed && LANDED[landed]) {
    say(note, LANDED[landed], landed === "confirmed" ? "ok" : "wait");
    if (landed === "confirmed") remember();
    clean("news");
  }

  if (token) {
    clean("unsubscribe");
    api("/api/news/unsubscribe", { method: "POST", body: { token } })
      .catch(() => ({ ok: false }))
      .then(({ ok }) => {
        if (ok) {
          forgetJoined();
          forget();
        }
        say(note, ok ? LEFT : NOT_LEFT, ok ? "ok" : "wait");
      });
  }
};
