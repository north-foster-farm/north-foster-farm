// The staging toolbar. Built into the page only on the staging branch
// deploy (layouts/partials/staging-toolbar.html decides), so
// production markup never carries it. Its sections (#303): the current
// time (the clock), email (this session's emails, what the site would
// have sent under MAIL_DRIVER=outbox, and the email and signature
// libraries), jobs (scheduled functions run only on the production
// deploy), orders (the sandbox card) and reset. It opens for every gate
// session (#294): the browser's cookie is the credential, so there is
// nothing to type. James's session opens more (Sent, Approve and
// Rewrite); /api/staging/info says which areas.
//
// States: open, collapsed to a tab (remembered per browser), or hidden
// for this view only: a refresh always brings it back (James, #206).
// The email library (library.js) opens from the panel or from a
// #email=<id> link, even when the toolbar is hidden.

import { hideExpired } from "../expiry/expiry.js";
import { onPress, setBusy } from "../utils/busy-button.js";
import { maybeShowOverlay, wireCopy } from "./card.js";
import { mountClock } from "./clock.js";
import { mountLibrary } from "./library.js";
import { mountNav } from "./nav.js";
import { keepOffset, OFFSET_KEY, savedOffset } from "./offset.js";
import { forgetEverything, unfinished } from "./reset.js";
import { SEEN_MAIL, unseen } from "./seen.js";
import { mountSignatures } from "./signatures.js";
import { mountSlips } from "./slips.js";

const root = document.getElementById("staging");
const qs = (sel) => root.querySelector(sel);
// What the toolbar keeps in this browser; Reset to defaults clears it.
const KEY = { open: "staging.open", reports: "staging.reports" };
// Hiding was once kept for the tab, which left no way back (#206).
const HIDDEN = "staging.hidden";

// `name` names the storage ("localStorage"), so a browser that blocks
// it throws inside the try: even reading window.localStorage can.
const store = (name, key, value) => {
  try {
    const bag = window[name];

    if (value === undefined) return bag.getItem(key);
    if (value === null) bag.removeItem(key);
    else bag.setItem(key, value);
  } catch {
    // Storage may be off; the toolbar then forgets between loads.
  }

  return value;
};

const api = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();

  return { ok: res.ok, status: res.status, data };
};

const when = (iso) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit",
  });

  return `${day} ${time}`;
};

const panel = qs("[data-staging-panel]");
const tab = qs("[data-staging-open]");
const list = qs("[data-staging-list]");
const empty = qs("[data-staging-empty]");
const out = qs("[data-staging-out]");
const mailBadge = qs("[data-staging-badge-email]");
const reports = qs("[data-staging-reset]");
// The areas the session opens, from /api/staging/info; the rest are
// hidden, not left to fail.
let can = [];
const allowed = (area) => can.includes(area);
const SIGNED_OUT = "Your gate session has ended. Reload to sign in again.";
let messages = [];
let timer = null;

// The Email badge: new arrivals since the section was last in view.
const badgeMail = () => {
  const n = unseen(messages, store("sessionStorage", SEEN_MAIL));

  mailBadge.textContent = n ? String(n) : "";
  mailBadge.hidden = !n;
  mailBadge.title = n === 1 ? "1 new email" : `${n} new emails`;
};

const seeMail = () => {
  store("sessionStorage", SEEN_MAIL, messages[0] ? messages[0].id : "");
  badgeMail();
};

const nav = mountNav({
  root,
  onSection: (id) => {
    if (id === "staging-email" && !panel.hidden) seeMail();
  },
});

const show = (open) => {
  panel.hidden = !open;
  tab.hidden = open;
  tab.setAttribute("aria-expanded", String(open));
  store("localStorage", KEY.open, open ? "1" : null);
  if (open) {
    nav.shown();
    poll();
  } else {
    clearTimeout(timer);
  }
};

const openMessage = (id) => {
  window.open(`/api/staging/outbox/${encodeURIComponent(id)}`, "_blank",
    "noopener");
};

const renderInbox = () => {
  list.replaceChildren();
  for (const m of messages) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    const to = Array.isArray(m.to) ? m.to.join(", ") : m.to;

    b.type = "button";
    b.className = "staging-mail";
    b.innerHTML = `<span class="staging-mail-subject"></span>` +
      `<span class="staging-mail-meta"></span>`;
    b.querySelector(".staging-mail-subject").textContent = m.subject;
    // A sign-in link sent to someone else is listed, never opened
    // (staging.mjs, ownLink).
    b.querySelector(".staging-mail-meta").textContent = m.withheld
      ? `${when(m.at)} · to ${to} · withheld: a sign-in link for ` +
        "another address"
      : `${when(m.at)} · to ${to}`;
    if (m.withheld) b.disabled = true;
    else b.addEventListener("click", () => openMessage(m.id));
    li.appendChild(b);
    list.appendChild(li);
  }
  empty.hidden = messages.length > 0;
  // The first look in this browser session counts nothing as new.
  if (store("sessionStorage", SEEN_MAIL) === null) seeMail();
  else if (!panel.hidden && nav.current() === "staging-email") seeMail();
  else badgeMail();
};

const poll = async () => {
  clearTimeout(timer);
  if (!allowed("inbox")) return;

  const { ok, status, data } = await api("/api/staging/outbox");

  if (ok) {
    messages = data.messages || [];
    renderInbox();
  }
  if (ok && out.textContent === SIGNED_OUT) say("");
  if (status === 401) {
    say(SIGNED_OUT);
  } else if (!panel.hidden) {
    timer = setTimeout(poll, 5000);
  }
};

const say = (text) => {
  out.textContent = text;
  out.hidden = !text;
};

const runJobs = async (at) => {
  const body = {};

  // A time of day: the server puts it on the day this browser's clock
  // reads, in the farm's zone.
  if (at) body.time = at;
  if (reports.checked) body.reset = true;
  say("Running…");

  const { ok, data } = await api("/api/staging/jobs/run", {
    method: "POST", body,
  });

  say(ok ? JSON.stringify(data, null, 2) : `Failed: ${JSON.stringify(data)}`);
  await poll();
};

// Back to the real time, for both resets. A session without the clock
// has nothing to undo.
const realTime = async () => {
  if (!allowed("clock")) return;
  try {
    await api("/api/staging/clock", { method: "DELETE" });
  } catch {
    // Offline: the reload below shows whether the clock is still set.
  }
};

const library = mountLibrary({
  root,
  api,
  onOpen: () => { root.hidden = false; },
  canReview: () => allowed("review"),
  canSeeSent: () => allowed("sent"),
});

const clock = mountClock({
  root,
  api,
  timeZone: root.dataset.timeZone,
  reload: () => window.location.reload(),
});

const signatures = mountSignatures({
  root,
  api,
  aloneUrl: (id) => `/api/staging/signatures/${encodeURIComponent(id)}`,
  onOpen: () => { root.hidden = false; },
});

const slips = mountSlips({
  root,
  api,
  onOpen: () => { root.hidden = false; },
});

// This bundle runs right after the site's, in the same deferred pass and
// before the first paint: move the date-bound blocks to the kept offset
// now, not after the info fetch, so the wrong block never shows (#385).
const offset = savedOffset(store("localStorage", OFFSET_KEY));

if (offset !== 0) hideExpired(document, Date.now() + offset);

const boot = async () => {
  store("sessionStorage", HIDDEN, null);

  const info = await api("/api/staging/info");

  // No gate session (a machine past the gate by its token): the
  // toolbar is not for this visitor, and the page carries no sign of it.
  if (!info.ok) return;

  root.hidden = false;
  can = info.data.can || [];
  if (info.data.clock && info.data.clock.available) {
    clock.draw(info.data.clock);
    // The date-bound blocks (expiry.js) read the browser's clock; make
    // them follow the toolbar's (#385). Keep the offset for the next
    // load's first pass (below); at 0 it is cleared, back to now.
    store("localStorage", OFFSET_KEY, keepOffset(info.data.clock.offset));
    hideExpired(document, new Date(info.data.clock.now).getTime());
  } else {
    can = can.filter((a) => a !== "clock");
  }
  maybeShowOverlay({ session: info.data.session });
  for (const el of root.querySelectorAll("[data-staging-scope]")) {
    el.hidden = !allowed(el.dataset.stagingScope);
  }
  nav.scope(allowed);
  if (allowed("emails")) library.fromHash();
  show(!!store("localStorage", KEY.open));
  // The badge counts while the toolbar is collapsed too.
  if (panel.hidden) poll();
  if (allowed("emails")) library.counted();
  if (allowed("signatures")) {
    signatures.fromHash();
    signatures.counted();
  }
  if (allowed("slips")) {
    slips.fromHash();
    slips.counted();
  }
};

wireCopy();
reports.checked = store("localStorage", KEY.reports) === "1";
reports.addEventListener("change", () => {
  store("localStorage", KEY.reports, reports.checked ? "1" : null);
});
tab.addEventListener("click", () => show(true));
qs("[data-staging-collapse]").addEventListener("click", () => show(false));
// Both resets stay busy until the page reloads.
qs("[data-staging-defaults]").addEventListener("click", async (ev) => {
  setBusy(ev.currentTarget, true);
  store("localStorage", KEY.reports, null);
  // The Email badge starts counting afresh from the next page.
  store("sessionStorage", SEEN_MAIL, null);
  await realTime();
  window.location.reload();
});
qs("[data-staging-forget]").addEventListener("click", async (ev) => {
  setBusy(ev.currentTarget, true);
  await realTime();

  const problem = unfinished(await forgetEverything());

  // Reloading would hide that the server kept the sign-in or the mail.
  if (problem) {
    say(problem);
    setBusy(ev.currentTarget, false);

    return;
  }
  window.location.reload();
});
qs("[data-staging-hide]").addEventListener("click", () => {
  root.hidden = true;
  clearTimeout(timer);
});
onPress(qs("[data-staging-refresh]"), poll);
onPress(qs("[data-staging-clear]"), async () => {
  await api("/api/staging/outbox", { method: "DELETE" });
  await poll();
});
for (const b of root.querySelectorAll("[data-staging-run]")) {
  onPress(b, () => runJobs(b.dataset.stagingRun));
}

boot();
