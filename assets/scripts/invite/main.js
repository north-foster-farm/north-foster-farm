// The page an invite link opens (#718): /invite/?t=<invite token>, a
// link the farm sends by hand. The page asks the server whether the
// invite is open and what it gives, then asks for an email address
// and sends a sign-in link to it. Following that link signs in, or
// makes the account, and puts the perk on it. The token leaves the
// address bar at once and stays in this tab only (join/token.mjs). The
// answer is the same for any address typed (#521). Draft wording.

import { perkSentence } from "../order/lib/perks.mjs";
import { api } from "../utils/api.js";
import { failBusy, isBusy, whileBusy } from "../utils/busy-button.js";
import { say } from "../utils/contact-link.js";
import { looksLikeEmail } from "../utils/email.js";
import { fieldError } from "../utils/field-errors.mjs";
import { dropToken, takeToken, tokenDead } from "../join/token.mjs";

const KEY = "nff_invite_token";

// The server's own words for a dead link, when it gave none.
// "[contact us]" becomes a link to sales@ (contact-link.js).
const INVALID = "That invite link isn't valid. If you already used " +
  "it, the invite is on your account. If not, [contact us] for a new one.";
// Draft, for James: the check didn't get an answer.
const UNCHECKED = "We couldn't open your invite just now. Check your " +
  "connection and reload the page.";

const start = async () => {
  const form = document.getElementById("invite-form");

  if (!form) return;

  const notice = document.getElementById("invite-notice");
  const ask = document.getElementById("invite-ask");
  const sent = document.getElementById("invite-sent");
  const submit = document.getElementById("invite-submit");
  const email = form.querySelector("#invite-email");
  const tab = { storage: () => window.sessionStorage, key: KEY };
  const token = takeToken({ location, history, ...tab });
  const tell = (message) => {
    say(notice, message);
    notice.hidden = false;
  };

  const { ok, status, data } = token
    ? await api("/api/invite/check", { method: "POST", body: { token } })
      .catch(() => ({ ok: false, status: 0, data: null }))
    : { ok: false, status: 404, data: null };

  if (!ok || !data || !data.perk) {
    if (tokenDead(status)) {
      dropToken(tab);
      tell((data && data.message) || INVALID);
    } else {
      // The token stays in this tab, so a reload tries again.
      tell(UNCHECKED);
    }

    return;
  }

  document.querySelector("[data-invite-perk]").textContent =
    perkSentence({ type: data.perk.type, end: data.perk.end });

  const parts = document.getElementById("invite-parts");

  for (const part of data.perk.parts || []) {
    const item = document.createElement("li");

    item.textContent = part;
    parts.append(item);
  }
  parts.hidden = !(data.perk.parts || []).length;
  ask.hidden = false;

  const showError = (message) => {
    email.classList.toggle("is-invalid", !!message);
    form.querySelector("[data-error-for='email']").textContent = message;
    if (message) email.focus();
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isBusy(submit)) return;

    const value = email.value.trim();

    if (!looksLikeEmail(value)) {
      showError(fieldError("email", value));

      return;
    }
    showError("");

    const r = await whileBusy(submit, api("/api/invite/request", {
      method: "POST",
      body: {
        token, email: value,
        website: form.querySelector("[name='website']").value,
      },
    }));

    if (!r.ok) {
      if (r.data && r.data.errors && r.data.errors.email) {
        showError(r.data.errors.email);
      } else if (tokenDead(r.status)) {
        dropToken(tab);
        ask.hidden = true;
        tell((r.data && r.data.message) || INVALID);
      } else {
        failBusy(submit, (r.data && r.data.message) || undefined);
      }

      return;
    }

    ask.hidden = true;
    sent.hidden = false;
  });

  document.getElementById("invite-again").addEventListener("click", () => {
    sent.hidden = true;
    ask.hidden = false;
    email.focus();
  });
};

document.addEventListener("DOMContentLoaded", start);
