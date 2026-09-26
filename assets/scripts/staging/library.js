// The email library: every email the site sends, built from sample
// data by /api/staging/emails, listed in a sidebar that searches names,
// tags, subjects and text, with the chosen one open beside it as HTML
// or plain text. Nothing here sends mail.
//
// #email=<id> on any page opens the library at that email, so a link
// to one can be handed to James; #emails opens it at the top.

const GROUPS = [
  ["customer", "To the customer"],
  ["farm", "To the farm"],
  ["list", "Farm news"],
];

// The email's own page, made to open its links outside the frame.
const framed = (html) => html.replace(/<head>/i,
  '<head><base target="_blank">');

export const mountLibrary = ({ root, api, onOpen }) => {
  const qs = (sel) => root.querySelector(sel);
  const box = qs("[data-staging-library]");
  const shelf = qs("[data-staging-shelf]");
  const empty = qs("[data-staging-shelf-empty]");
  const search = qs("[data-staging-search]");
  const summary = qs("[data-staging-library-summary]");
  const count = qs("[data-staging-library-count]");
  const reader = qs("[data-staging-reader]");
  const frame = qs("[data-staging-frame]");
  const textView = qs("[data-staging-text]");
  const item = qs("[data-staging-item]");
  const filters = root.querySelectorAll("[data-staging-filter]");
  const views = root.querySelectorAll("[data-staging-view]");
  let emails = null;
  let current = null;
  let view = "html";
  let approval = "";
  let loading = null;

  const haystack = (e) => [e.id, e.name, e.when, e.subject, e.text,
    e.approval, e.audience, ...(e.tags || [])].join("\n").toLowerCase();

  const matches = (e) => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = haystack(e);

    return (!approval || e.approval === approval)
      && words.every((w) => hay.includes(w));
  };

  const badge = (el, e) => {
    el.textContent = e.approval;
    el.dataset.approval = e.approval;
  };

  const drawShelf = () => {
    for (const old of shelf.querySelectorAll(".staging-group")) old.remove();

    let shown = 0;

    for (const [audience, title] of GROUPS) {
      const list = emails.filter((e) => e.audience === audience && matches(e));

      if (!list.length) continue;
      shown += list.length;

      const group = document.createElement("section");
      const h = document.createElement("h2");
      const ol = document.createElement("ol");

      group.className = "staging-group";
      h.textContent = `${title} (${list.length})`;
      for (const e of list) {
        const li = item.content.firstElementChild.cloneNode(true);
        const a = li.querySelector("a");
        const tags = li.querySelector(".staging-item-tags");

        a.href = `#email=${encodeURIComponent(e.id)}`;
        a.dataset.id = e.id;
        if (current && current.id === e.id) {
          a.setAttribute("aria-current", "true");
        }
        li.querySelector(".staging-item-name").textContent = e.name;
        li.querySelector(".staging-item-subject").textContent = e.subject;
        badge(tags.firstElementChild, e);
        for (const tag of e.tags) {
          const t = document.createElement("button");

          t.type = "button";
          t.className = "staging-tag";
          t.dataset.tag = tag;
          t.textContent = tag;
          tags.appendChild(t);
        }
        ol.appendChild(li);
      }
      group.append(h, ol);
      shelf.appendChild(group);
    }
    empty.hidden = shown > 0;
  };

  const drawSummary = () => {
    const waiting = emails.filter((e) => e.approval !== "approved").length;
    const text = `${emails.length}, ${waiting} to approve`;

    summary.textContent = text;
    count.textContent = text;
  };

  const load = () => {
    loading = loading || api("/api/staging/emails").then(({ ok, data }) => {
      emails = ok ? data.emails : [];
      if (!ok) {
        empty.textContent = "The library could not be loaded.";
        empty.hidden = false;
        loading = null;

        return;
      }
      drawSummary();
      drawShelf();
    });

    return loading;
  };

  const drawView = async () => {
    for (const b of views) {
      b.setAttribute("aria-pressed", String(b.dataset.stagingView === view));
    }
    frame.hidden = view !== "html";
    textView.hidden = view !== "text";

    const id = current.id;
    const path = `/api/staging/emails/${encodeURIComponent(id)}${
      view === "text" ? "?format=text" : ""}`;
    const { ok, data } = await api(path);

    if (!current || current.id !== id) return;
    if (view === "text") textView.textContent = ok ? data : "Not found.";
    else frame.srcdoc = ok ? framed(data) : "<p>Not found.</p>";
  };

  const read = async (id) => {
    await load();
    current = emails.find((e) => e.id === id) || null;
    reader.hidden = !current;
    box.classList.toggle("staging-reading", !!current);
    drawShelf();
    if (!current) return;

    qs("[data-staging-reader-name]").textContent = current.name;
    qs("[data-staging-reader-when]").textContent = current.when;
    qs("[data-staging-reader-subject]").textContent =
      `Subject: ${current.subject}`;
    badge(qs("[data-staging-reader-approval]"), current);

    const note = qs("[data-staging-reader-note]");

    note.textContent = current.note || "";
    note.hidden = !current.note;
    drawView();
  };

  const open = (id = null) => {
    onOpen();
    box.hidden = false;
    document.documentElement.classList.add("staging-library-open");
    load();
    if (id) read(id);
    else if (!current) search.focus();
  };

  const close = () => {
    box.hidden = true;
    document.documentElement.classList.remove("staging-library-open");
    if (/^#emails?\b/.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  };

  const fromHash = () => {
    const m = location.hash.match(/^#email=([^&]+)/);

    if (m) open(decodeURIComponent(m[1]));
    else if (location.hash === "#emails") open();
  };

  shelf.addEventListener("click", (ev) => {
    const tag = ev.target.closest("[data-tag]");

    if (tag) {
      ev.preventDefault();
      search.value = tag.dataset.tag;
      drawShelf();

      return;
    }

    const a = ev.target.closest("a[data-id]");

    if (!a) return;
    ev.preventDefault();
    history.replaceState(null, "", a.getAttribute("href"));
    read(a.dataset.id);
  });
  search.addEventListener("input", () => emails && drawShelf());
  for (const b of filters) {
    b.addEventListener("click", () => {
      approval = b.dataset.stagingFilter;
      for (const f of filters) {
        f.setAttribute("aria-pressed", String(f === b));
      }
      if (emails) drawShelf();
    });
  }
  for (const b of views) {
    b.addEventListener("click", () => {
      view = b.dataset.stagingView;
      if (current) drawView();
    });
  }
  qs("[data-staging-reader-back]").addEventListener("click", () => {
    current = null;
    reader.hidden = true;
    box.classList.remove("staging-reading");
    history.replaceState(null, "", "#emails");
    drawShelf();
  });
  qs("[data-staging-copy-link]").addEventListener("click", async (ev) => {
    const link = `${location.origin}/#email=${encodeURIComponent(current.id)}`;
    const b = ev.currentTarget;

    try {
      await navigator.clipboard.writeText(link);
      b.textContent = "Copied";
    } catch {
      prompt("The link to this email:", link);
    }
    setTimeout(() => { b.textContent = "Copy link"; }, 1200);
  });
  qs("[data-staging-library-open]").addEventListener("click", () => open());
  qs("[data-staging-library-close]").addEventListener("click", close);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !box.hidden) close();
  });
  window.addEventListener("hashchange", fromHash);

  // The count on the toolbar's button, without opening anything.
  const counted = () => load();

  return { fromHash, counted };
};
