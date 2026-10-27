// A buying group's sign-up page (#495): /join/?t=<join token>, the
// link a group's QR code carries. The page asks the server whether the
// token is in force and what the group is called, then either asks for
// the name, email address and Farm News, and sends the link (which
// signs in an account holder too, so the token never rides through the
// sign-in page's next; join/token.mjs keeps it out of the address
// bar), or, for
// someone signed in, joins with one button. Either way the join dialog
// (group/join-dialog.js) asks first. Draft wording, but for the
// dialog's and ALREADY, which James approved.

import { confirmJoin } from "../group/join-dialog.js";
import { api } from "../utils/api.js";
import { failBusy, isBusy, whileBusy } from "../utils/busy-button.js";
import { say } from "../utils/contact-link.js";
import { looksLikeEmail } from "../utils/email.js";
import { fieldError } from "../utils/field-errors.mjs";
import { forget } from "../session/session.js";
import { dropToken, takeToken } from "./token.mjs";

const INVALID = "That link to join a group isn't valid. Ask the group's " +
  "host for a new one.";
// James's approved wording (#495, decision 5).
const ALREADY = "You're already in the group.";
const ELSEWHERE = "Your account is already in another group, so this one " +
  "can't be added.";

const start = async () => {
  const form = document.getElementById("join-form");

  if (!form) return;

  const notice = document.getElementById("join-notice");
  const ask = document.getElementById("join-ask");
  const signedIn = document.getElementById("join-signed-in");
  const sent = document.getElementById("join-sent");
  const submit = document.getElementById("join-submit");
  const now = document.getElementById("join-now");
  // Off the address bar at once, and never into another URL.
  const tab = { storage: () => window.sessionStorage };
  const token = takeToken({ location, history, ...tab });
  const tell = (message) => {
    say(notice, message);
    notice.hidden = false;
  };

  const { ok, data } = token
    ? await api("/api/join/check", { method: "POST", body: { token } })
      .catch(() => ({ ok: false, data: null }))
    : { ok: false, data: null };

  if (!ok || !data || !data.group) {
    dropToken(tab);
    tell((data && data.message) || INVALID);

    return;
  }

  for (const el of document.querySelectorAll("[data-join-group]")) {
    el.textContent = data.group.name;
  }

  if (data.already || data.elsewhere) dropToken(tab);
  if (data.already) {
    tell(ALREADY);

    return;
  }
  if (data.elsewhere) {
    tell(ELSEWHERE);

    return;
  }
  if (data.signedIn) {
    signedIn.hidden = false;
    now.addEventListener("click", async () => {
      if (isBusy(now)) return;
      if (!(await confirmJoin(data.group.name))) return;

      const r = await whileBusy(now, api("/api/join", {
        method: "POST", body: { token },
      }));

      if (!r.ok) {
        failBusy(now, r.data && r.data.message);

        return;
      }
      // /api/me now names the group: the header's menu and the
      // account page ask again.
      forget();
      dropToken(tab);
      location.href = r.data.next;
    });

    return;
  }

  ask.hidden = false;

  const fields = {
    firstName: form.querySelector("#join-first"),
    lastName: form.querySelector("#join-last"),
    email: form.querySelector("#join-email"),
  };
  const showErrors = (errors) => {
    for (const [name, input] of Object.entries(fields)) {
      const message = errors[name] || "";

      input.classList.toggle("is-invalid", !!message);
      form.querySelector(`[data-error-for='${name}']`).textContent = message;
    }

    const first = Object.keys(fields).find((name) => errors[name]);

    if (first) fields[first].focus();
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isBusy(submit)) return;

    const value = (name) => fields[name].value.trim();
    const errors = {};

    if (!value("firstName")) errors.firstName = "Please enter your first name.";
    if (!value("lastName")) errors.lastName = "Please enter your last name.";
    if (!looksLikeEmail(value("email"))) {
      errors.email = fieldError("email", value("email"));
    }
    showErrors(errors);
    if (Object.keys(errors).length) return;
    // The link joins them when they open it, so they say Join first,
    // as everywhere a group's code is used (#495, decision 5).
    if (!(await confirmJoin(data.group.name))) return;

    const r = await whileBusy(submit, api("/api/join/request", {
      method: "POST",
      body: {
        token,
        firstName: value("firstName"),
        lastName: value("lastName"),
        email: value("email"),
        news: form.querySelector("#join-news").checked,
        website: form.querySelector("[name='website']").value,
      },
    }));

    if (!r.ok) {
      if (r.data && r.data.errors) {
        showErrors(r.data.errors);
      } else {
        failBusy(submit, (r.data && r.data.message) || undefined);
      }

      return;
    }

    ask.hidden = true;
    sent.hidden = false;
  });

  document.getElementById("join-again").addEventListener("click", () => {
    sent.hidden = true;
    ask.hidden = false;
    fields.email.focus();
  });
};

document.addEventListener("DOMContentLoaded", start);
