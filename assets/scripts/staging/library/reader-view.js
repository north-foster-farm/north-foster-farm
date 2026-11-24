// The open email drawn (docs/refactors/staging-library.md, phase 3):
// its name, when, subject, approval and note, the files it carries,
// and which of its three panes shows. Every value is written as text;
// the email's HTML goes into the frame from reader.js alone.

import { badge } from "./shelf-view.js";

// `qs` finds an element of the toolbar.
export const drawHead = (qs, email) => {
  qs("[data-staging-reader-name]").textContent = email.name;
  qs("[data-staging-reader-when]").textContent = email.when;
  qs("[data-staging-reader-subject]").textContent =
    `Subject: ${email.subject}`;
  badge(qs("[data-staging-reader-approval]"), email);

  const note = qs("[data-staging-reader-note]");

  note.textContent = email.note || "";
  note.hidden = !email.note;
};

// A PDF the email carries (the packing slips), opened in a tab.
export const drawFiles = (qs, files) => {
  const holder = qs("[data-staging-reader-files]");

  holder.replaceChildren(...files.flatMap((f, i) => {
    const a = document.createElement("a");

    a.href = f.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = f.filename;

    return i ? [", ", a] : [a];
  }));
  qs("[data-staging-reader-attachments]").hidden = !files.length;
};

// The Rewrite view's button, for an email James rewrote alone.
export const drawViewButtons = (views, mine) => {
  for (const b of views) {
    if (b.dataset.stagingView === "rewrite") b.hidden = !mine;
  }
};

// The view's button pressed and its pane shown; none while the editor
// is open.
export const drawPanes = (el, view, editing) => {
  for (const b of el.views) {
    b.setAttribute("aria-pressed", String(b.dataset.stagingView === view));
  }
  el.frame.hidden = editing || view !== "html";
  el.textView.hidden = editing || view !== "text";
  el.rewritten.hidden = editing || view !== "rewrite";
};
