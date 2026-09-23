// The staging toolbar. Built into the page only when the deploy is
// not production (layouts/partials/staging-toolbar.html decides), so
// production markup never carries it. Two tools: the outbox, where
// every email the site would have sent lands under MAIL_DRIVER=outbox,
// and the jobs trigger, since scheduled functions run only on the
// production deploy.
//
// States: open, collapsed to a tab (remembered per browser), or hidden
// until the next load (per tab), so a review of the page itself is
// not disturbed.

const root = document.getElementById("staging");
const qs = (sel) => root.querySelector(sel);
const KEY = { open: "staging.open", token: "staging.token" };
const HIDDEN = "staging.hidden";
const store = (bag, key, value) => {
  try {
    if (value === undefined) return bag.getItem(key);
    if (value === null) bag.removeItem(key);
    else bag.setItem(key, value);
  } catch {
    // Storage may be off; the toolbar then forgets between loads.
  }

  return value;
};

const token = () => store(localStorage, KEY.token) || "";

const api = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    const given = prompt("Staging token:");

    if (given) {
      store(localStorage, KEY.token, given.trim());

      return api(path, { method, body });
    }
  }

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
let seen = "";
let timer = null;

const show = (open) => {
  panel.hidden = !open;
  tab.hidden = open;
  tab.setAttribute("aria-expanded", String(open));
  store(localStorage, KEY.open, open ? "1" : null);
  if (open) poll();
  else clearTimeout(timer);
};

const openMessage = (id) => {
  const url = `/api/staging/outbox/${encodeURIComponent(id)}${
    token() ? `?token=${encodeURIComponent(token())}` : ""}`;

  window.open(url, "_blank", "noopener");
};

const renderInbox = (messages) => {
  const newest = messages[0] ? messages[0].id : "";

  list.replaceChildren();
  for (const m of messages) {
    const li = document.createElement("li");
    const b = document.createElement("button");

    b.type = "button";
    b.className = "staging-mail";
    b.innerHTML = `<span class="staging-mail-subject"></span>` +
      `<span class="staging-mail-meta"></span>`;
    b.querySelector(".staging-mail-subject").textContent = m.subject;
    b.querySelector(".staging-mail-meta").textContent =
      `${when(m.at)} · to ${Array.isArray(m.to) ? m.to.join(", ") : m.to}`;
    b.addEventListener("click", () => openMessage(m.id));
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

  const { ok, data } = await api("/api/staging/outbox");

  if (ok) renderInbox(data.messages || []);
  if (!panel.hidden) timer = setTimeout(poll, 5000);
};

const say = (text) => {
  out.textContent = text;
  out.hidden = !text;
};

const runJobs = async (at) => {
  const reset = qs("[data-staging-reset]").checked;
  const body = {};

  if (at) {
    const [h, m] = at.split(":").map(Number);
    const d = new Date();

    d.setHours(h, m, 0, 0);
    body.at = d.toISOString();
  }
  if (reset) body.reset = true;
  say("Running…");

  const { ok, data } = await api("/api/staging/jobs/run", {
    method: "POST", body,
  });

  say(ok ? JSON.stringify(data, null, 2) : `Failed: ${JSON.stringify(data)}`);
  poll();
};

const boot = async () => {
  if (store(sessionStorage, HIDDEN)) return;

  root.hidden = false;
  const info = await api("/api/staging/info");

  if (info.ok) {
    qs("[data-staging-info]").textContent =
      `${info.data.context} · mail ${info.data.mailDriver} · Square ${
        info.data.squareEnv}`;
  }
  show(!!store(localStorage, KEY.open));
};

tab.addEventListener("click", () => show(true));
qs("[data-staging-collapse]").addEventListener("click", () => show(false));
qs("[data-staging-hide]").addEventListener("click", () => {
  store(sessionStorage, HIDDEN, "1");
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
