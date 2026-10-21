// The staging toolbar. Built into the page only on the staging branch
// deploy (layouts/partials/staging-toolbar.html decides), so
// production markup never carries it. Its tools: this session's
// emails (what the site would have sent, under MAIL_DRIVER=outbox),
// the clock, the jobs trigger (scheduled functions run only on the
// production deploy), the email library and the sandbox card. It opens
// for every gate session (#294): the browser's cookie is the
// credential, so there is nothing to type. James's session opens more
// (Sent, Approve and Rewrite); /api/staging/info says which areas.
//
// States: open, collapsed to a tab (remembered per browser), or hidden
// for this view only: a refresh always brings it back (James, #206).
// The email library (library.js) opens from the panel or from a
// #email=<id> link, even when the toolbar is hidden.

import { maybeShowOverlay, wireCopy } from "./card.js";
import { mountClock } from "./clock.js";
import { mountLibrary } from "./library.js";
import { forgetEverything } from "./reset.js";
import { mountSignatures } from "./signatures.js";

const root = document.getElementById("staging");
const qs = (sel) => root.querySelector(sel);
const KEY = { open: "staging.open" };
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
// The areas the session opens, from /api/staging/info; the rest are
// hidden, not left to fail.
let can = [];
const allowed = (area) => can.includes(area);
const SIGNED_OUT = "Your gate session has ended. Reload to sign in again.";
let seen = "";
let timer = null;

const show = (open) => {
  panel.hidden = !open;
  tab.hidden = open;
  tab.setAttribute("aria-expanded", String(open));
  store("localStorage", KEY.open, open ? "1" : null);
  if (open) poll();
  else clearTimeout(timer);
};

const openMessage = (id) => {
  window.open(`/api/staging/outbox/${encodeURIComponent(id)}`, "_blank",
    "noopener");
};

const renderInbox = (messages) => {
  const newest = messages[0] ? messages[0].id : "";

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
  if (newest && seen && newest !== seen) {
    root.classList.add("staging-new");
    setTimeout(() => root.classList.remove("staging-new"), 1500);
  }
  seen = newest;
};

const poll = async () => {
  clearTimeout(timer);
  if (!allowed("inbox")) return;

  const { ok, status, data } = await api("/api/staging/outbox");

  if (ok) renderInbox(data.messages || []);
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
  const reset = qs("[data-staging-reset]").checked;
  const body = {};

  // A time of day: the server puts it on the day this browser's clock
  // reads, in the farm's zone.
  if (at) body.time = at;
  if (reset) body.reset = true;
  say("Running…");

  const { ok, data } = await api("/api/staging/jobs/run", {
    method: "POST", body,
  });

  say(ok ? JSON.stringify(data, null, 2) : `Failed: ${JSON.stringify(data)}`);
  poll();
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
  } else {
    can = can.filter((a) => a !== "clock");
  }
  maybeShowOverlay({ session: info.data.session });
  qs("[data-staging-info]").textContent = `${info.data.context} · mail ${
    info.data.mailDriver} · Square ${info.data.squareEnv}`;
  for (const el of root.querySelectorAll("[data-staging-scope]")) {
    el.hidden = !allowed(el.dataset.stagingScope);
  }
  if (allowed("emails")) library.fromHash();
  show(!!store("localStorage", KEY.open));
  if (allowed("emails")) library.counted();
  if (allowed("signatures")) {
    signatures.fromHash();
    signatures.counted();
  }
};

wireCopy();
tab.addEventListener("click", () => show(true));
qs("[data-staging-collapse]").addEventListener("click", () => show(false));
qs("[data-staging-forget]").addEventListener("click", async () => {
  await forgetEverything();
  window.location.reload();
});
qs("[data-staging-hide]").addEventListener("click", () => {
  root.hidden = true;
  clearTimeout(timer);
});
qs("[data-staging-refresh]").addEventListener("click", poll);
qs("[data-staging-clear]").addEventListener("click", async () => {
  await api("/api/staging/outbox", { method: "DELETE" });
  poll();
});
for (const b of root.querySelectorAll("[data-staging-run]")) {
  b.addEventListener("click", () => runJobs(b.dataset.stagingRun));
}

boot();
