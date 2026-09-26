// The email library: every email the site sends, built from sample
// data by /api/staging/emails, listed in a sidebar that searches names,
// tags, subjects and text, with the chosen one open beside it as HTML
// or plain text. Nothing here sends mail.
//
// James reviews from here: Approve saves his approval of the email as
// it reads now; Rewrite, for one he has not approved, opens its
// subject and text for editing, with the sample values (name, order,
// dates, amounts, links) as tokens he can move or delete but not
// change. Both are saved on this deploy (lib/review.mjs) until an
// agent ports them into the code.
//
// #email=<id> on any page opens the library at that email, so a link
// to one can be handed to James; #emails opens it at the top.

const GROUPS = [
  ["customer", "To the customer"],
  ["farm", "To the farm"],
  ["list", "Farm news"],
];

const LABELS = { rewritten: "rewritten, to apply" };

// The email's own page, made to open its links outside the frame.
const framed = (html) => html.replace(/<head>/i,
  '<head><base target="_blank">');

const day = (iso) => new Date(iso).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

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
  const rewritten = qs("[data-staging-rewritten]");
  const item = qs("[data-staging-item]");
  const tokenTemplate = qs("[data-staging-token]");
  const filters = root.querySelectorAll("[data-staging-filter]");
  const views = root.querySelectorAll("[data-staging-view]");
  const review = {
    bar: qs("[data-staging-review]"),
    status: qs("[data-staging-review-status]"),
    approve: qs("[data-staging-approve]"),
    rewrite: qs("[data-staging-rewrite]"),
    withdraw: qs("[data-staging-withdraw]"),
    revert: qs("[data-staging-revert]"),
    error: qs("[data-staging-review-error]"),
  };
  const editor = {
    form: qs("[data-staging-editor]"),
    subject: qs("[data-staging-edit-subject]"),
    text: qs("[data-staging-edit-text]"),
    dropped: qs("[data-staging-edit-dropped]"),
    error: qs("[data-staging-edit-error]"),
  };
  let emails = null;
  let current = null;
  let view = "html";
  let approval = "";
  let loading = null;
  let editing = false;

  const haystack = (e) => [e.id, e.name, e.when, e.subject, e.text,
    e.approval, LABELS[e.approval], e.audience, ...(e.tags || [])]
    .join("\n").toLowerCase();

  const matches = (e) => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = haystack(e);

    return (!approval || e.approval === approval)
      && words.every((w) => hay.includes(w));
  };

  const badge = (el, e) => {
    el.textContent = LABELS[e.approval] || e.approval;
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
    const waiting = emails.filter((e) => e.approval === "to approve").length;
    const redone = emails.filter((e) => e.approval === "rewritten").length;
    const text = `${emails.length}, ${waiting} to approve${
      redone ? `, ${redone} rewritten` : ""}`;

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

  // --- Parts: text with the sample values as tokens -----------------

  const token = (value) => {
    const span = tokenTemplate.content.firstElementChild.cloneNode(true);

    span.textContent = value;
    span.dataset.token = value;

    return span;
  };

  // In the editor, a click beside a token can leave the caret inside
  // it, where nothing can be typed, so each token is wrapped in
  // invisible anchors for the caret to land in. partsOf drops them.
  const ANCHOR = "​";

  const fill = (el, parts, anchored = false) => {
    const anchor = () => document.createTextNode(ANCHOR);

    el.replaceChildren(...parts.flatMap((p) => {
      if (p.token === undefined) return [document.createTextNode(p.text)];

      return anchored ? [anchor(), token(p.token), anchor()] : [token(p.token)];
    }));
  };

  // The editor's content back as parts. A browser may wrap new lines
  // in <div> or <br> rather than a newline character; both count as
  // one.
  const partsOf = (el) => {
    const out = [];
    const add = (text) => {
      const last = out.at(-1);

      if (last && last.text !== undefined) last.text += text;
      else out.push({ text });
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          add(child.data.replaceAll(ANCHOR, ""));
        } else if (child.dataset && child.dataset.token !== undefined) {
          out.push({ token: child.dataset.token });
        } else if (child.nodeName === "BR") {
          add("\n");
        } else {
          if (/^(DIV|P)$/.test(child.nodeName) && out.length) add("\n");
          walk(child);
        }
      }
    };

    walk(el);

    return out.filter((p) => p.token !== undefined || p.text);
  };

  // A click past the end of a line that ends in a token leaves the
  // caret inside the token, where typing does nothing. Move it to the
  // anchor on the nearer side.
  const outOfToken = () => {
    const s = getSelection();

    if (!editing || !s.rangeCount || !s.isCollapsed) return;

    const node = s.anchorNode;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    const tok = el.closest && el.closest("[data-token]");

    if (!tok || !editor.form.contains(tok)) return;

    const after = s.anchorOffset >= tok.textContent.length / 2;
    const side = after ? tok.nextSibling : tok.previousSibling;
    const r = document.createRange();

    if (side && side.nodeType === Node.TEXT_NODE) {
      r.setStart(side, after ? Math.min(1, side.length) : side.length);
    } else if (after) {
      r.setStartAfter(tok);
    } else {
      r.setStartBefore(tok);
    }
    s.removeAllRanges();
    s.addRange(r);
  };

  document.addEventListener("selectionchange", outOfToken);

  const tokensOf = (parts) => parts
    .filter((p) => p.token !== undefined).map((p) => p.token);

  // --- The open email ------------------------------------------------

  const drawView = async () => {
    for (const b of views) {
      b.setAttribute("aria-pressed", String(b.dataset.stagingView === view));
    }
    frame.hidden = editing || view !== "html";
    textView.hidden = editing || view !== "text";
    rewritten.hidden = editing || view !== "rewrite";
    if (view === "rewrite") {
      const { subject, text } = current.rewrite;

      fill(rewritten, [{ text: "Subject: " }, ...subject, { text: "\n\n" },
        ...text]);

      return;
    }

    const id = current.id;
    const path = `/api/staging/emails/${encodeURIComponent(id)}${
      view === "text" ? "?format=text" : ""}`;
    const { ok, data } = await api(path);

    if (!current || current.id !== id) return;
    if (view === "text") textView.textContent = ok ? data : "Not found.";
    else frame.srcdoc = ok ? framed(data) : "<p>Not found.</p>";
  };

  const drawReview = () => {
    const e = current;
    const byCode = e.approvedBy === "code";
    const show = {
      approve: e.approval === "to approve",
      rewrite: e.approval === "to approve" || e.approval === "rewritten",
      withdraw: e.approval === "approved" && !byCode,
      revert: e.approval === "rewritten",
    };

    review.bar.hidden = byCode || !!e.error;
    for (const [name, on] of Object.entries(show)) {
      review[name].hidden = !on || editing;
    }
    review.rewrite.textContent = e.approval === "rewritten"
      ? "Edit the rewrite" : "Rewrite";
    review.status.textContent = {
      approved: e.approvedAt ? `You approved it ${day(e.approvedAt)}.` : "",
      rewritten: e.rewrite ? `You rewrote it ${day(e.rewrite.at)}. ` +
        "It goes into the code next." : "",
    }[e.approval] || "";
    review.status.hidden = !review.status.textContent;
    review.error.hidden = true;
  };

  const drawReader = () => {
    qs("[data-staging-reader-name]").textContent = current.name;
    qs("[data-staging-reader-when]").textContent = current.when;
    qs("[data-staging-reader-subject]").textContent =
      `Subject: ${current.subject}`;
    badge(qs("[data-staging-reader-approval]"), current);

    const note = qs("[data-staging-reader-note]");

    note.textContent = current.note || "";
    note.hidden = !current.note;

    const mine = current.approval === "rewritten";

    for (const b of views) {
      if (b.dataset.stagingView === "rewrite") b.hidden = !mine;
    }
    if (!mine && view === "rewrite") view = "html";
    drawReview();
    drawView();
  };

  const closeEditor = () => {
    editing = false;
    editor.form.hidden = true;
  };

  const read = async (id) => {
    await load();
    closeEditor();
    current = emails.find((e) => e.id === id) || null;
    reader.hidden = !current;
    box.classList.toggle("staging-reading", !!current);
    drawShelf();
    if (!current) return;
    if (current.approval === "rewritten") view = "rewrite";
    drawReader();
  };

  // A review saved: the server's answer replaces the email everywhere
  // it shows, without a reload.
  const saved = (email) => {
    emails = emails.map((e) => (e.id === email.id ? email : e));
    if (current && current.id === email.id) current = email;
    drawSummary();
    drawShelf();
    drawReader();
  };

  const send = async (kind, method, body, errorEl) => {
    const path = `/api/staging/emails/${encodeURIComponent(current.id)}/${
      kind}`;
    const { ok, data } = await api(path, { method, body });

    if (!ok) {
      errorEl.textContent = (data && data.error) || "That did not save.";
      errorEl.hidden = false;

      return false;
    }
    saved(data.email);

    return true;
  };

  const openEditor = () => {
    const from = current.approval === "rewritten"
      ? current.rewrite : current.parts;

    fill(editor.subject, from.subject, true);
    fill(editor.text, from.text, true);
    for (const el of [editor.subject, editor.text]) {
      try {
        el.contentEditable = "plaintext-only";
      } catch {
        el.contentEditable = "true";
      }
    }
    editor.dropped.hidden = true;
    editor.error.hidden = true;
    editing = true;
    editor.form.hidden = false;
    drawReview();
    drawView();
    editor.text.focus();
  };

  // Which of the email's sample values the rewrite leaves out.
  const noteDropped = () => {
    const had = tokensOf([...current.parts.subject, ...current.parts.text]);
    const kept = new Set(tokensOf([...partsOf(editor.subject),
      ...partsOf(editor.text)]));
    const gone = [...new Set(had.filter((t) => !kept.has(t)))];

    editor.dropped.textContent = gone.length
      ? `Left out: ${gone.join(", ")}` : "";
    editor.dropped.hidden = !gone.length;
  };

  review.approve.addEventListener("click", () => send("approval", "PUT",
    { version: current.version }, review.error));
  review.withdraw.addEventListener("click", () => send("approval",
    "DELETE", undefined, review.error));
  review.revert.addEventListener("click", () => {
    if (!confirm("Drop your rewrite and keep the current wording?")) return;
    view = "html";
    send("rewrite", "DELETE", undefined, review.error);
  });
  review.rewrite.addEventListener("click", openEditor);
  editor.subject.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") ev.preventDefault();
  });
  editor.form.addEventListener("input", noteDropped);
  editor.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    editor.error.hidden = true;

    const subject = partsOf(editor.subject)
      .map((p) => (p.text === undefined ? p
        : { text: p.text.replace(/\s*\n\s*/g, " ") }));
    const ok = await send("rewrite", "PUT", {
      version: current.version, subject, text: partsOf(editor.text),
    }, editor.error);

    if (ok) {
      closeEditor();
      view = "rewrite";
      drawReader();
    }
  });
  qs("[data-staging-edit-cancel]").addEventListener("click", () => {
    closeEditor();
    drawReview();
    drawView();
  });

  // --- Opening and closing -------------------------------------------

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
      if (current && !editing) drawView();
    });
  }
  qs("[data-staging-reader-back]").addEventListener("click", () => {
    current = null;
    closeEditor();
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
    if (ev.key === "Escape" && !box.hidden && !editing) close();
  });
  window.addEventListener("hashchange", fromHash);

  // The count on the toolbar's button, without opening anything.
  const counted = () => load();

  return { fromHash, counted };
};
