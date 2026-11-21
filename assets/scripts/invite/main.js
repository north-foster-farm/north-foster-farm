// The page an invite link opens (#718): /invite/?t=<invite token>, a
// link the farm sends by hand. The page asks the server whether the
// invite is open and what it gives, then asks for an email address
// and sends a sign-in link to it. Following that link signs in, or
// makes the account, and puts the perk on it. The token leaves the
// address bar at once and stays in this tab only (join/token.mjs). The
// answer is the same for any address typed (#521). James's wording,
// approved 2026-11-21 (#733).

import { perkName } from "../order/lib/perks.mjs";
import { api } from "../utils/api.js";
import { failBusy, isBusy, whileBusy } from "../utils/busy-button.js";
import { say } from "../utils/contact-link.js";
import { looksLikeEmail } from "../utils/email.js";
import { fieldError } from "../utils/field-errors.mjs";
import { dropToken, takeToken, tokenDead } from "../join/token.mjs";

const KEY = "nff_invite_token";

// The check didn't get an answer. "[contact us]" becomes a link to
// sales@ (contact-link.js). A dead link shows the page's own block,
// #invite-dead, in place of the server's one-line message.
const UNCHECKED = "Something went wrong when we tried to load your " +
  "invitation. Try again in a minute or two, or [contact us] if the " +
  "issue persists.";

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
  const dead = document.getElementById("invite-dead");
  const tell = (message) => {
    say(notice, message);
    notice.hidden = false;
  };
  const showDead = () => {
    dropToken(tab);
    ask.hidden = true;
    dead.hidden = false;
  };

  const { ok, status, data } = token
    ? await api("/api/invite/check", { method: "POST", body: { token } })
      .catch(() => ({ ok: false, status: 0, data: null }))
    : { ok: false, status: 404, data: null };

  if (!ok || !data || !data.perk) {
    if (tokenDead(status)) {
      showDead();
    } else {
      // The token stays in this tab, so a reload tries again.
      tell(UNCHECKED);
    }

    return;
  }

  // A bundled perk lists its parts; a standalone one is its own line,
  // "Free delivery".
  const type = data.perk.type;
  const parts = document.getElementById("invite-parts");

  for (const part of data.perk.parts ||
    [data.perk.name || perkName(type)]) {
    const item = document.createElement("li");

    item.textContent = part;
    parts.append(item);
  }
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
        showDead();
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
