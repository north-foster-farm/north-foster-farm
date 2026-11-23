// The library's reader (docs/refactors/staging-library.md, phase 3):
// the chosen email as HTML in a frame, as plain text, or as James's
// rewrite, with its view buttons, Back and Copy link.
//
// `r` is what library.js hands it: the elements (`el`), `qs`, the
// `api`, the record's getter and setter (`get`, `set`; a setter draws
// nothing), and `load`, `drawShelf`, `drawReview` and `closeEditor`.

import { rewriteParts } from "./parts.mjs";
import {
  drawFiles, drawHead, drawPanes, drawViewButtons,
} from "./reader-view.js";
import { emailPath, framed, linkTo, viewFor } from "./review.mjs";
import { opened } from "./state.mjs";
import { fill } from "./tokens.js";

// The view is read again once the email has come, as the closure's
// variable was before the move.
const drawView = async (r) => {
  const { el, api, get } = r;
  const { current, view, editing } = get();

  drawPanes(el, view, editing);
  if (view === "rewrite") {
    fill(el.tokenTemplate, el.rewritten, rewriteParts(current.rewrite));

    return;
  }

  const id = current.id;
  const { ok, data } = await api(emailPath(id, view));
  const now = get();

  if (!now.current || now.current.id !== id) return;
  if (now.view === "text") el.textView.textContent = ok ? data : "Not found.";
  else el.frame.srcdoc = ok ? framed(data) : "<p>Not found.</p>";
};

const drawReader = (r) => {
  const { current } = r.get();

  drawHead(r.qs, current);
  drawFiles(r.qs, current.attachments || []);
  drawViewButtons(r.el.views, current.approval === "rewritten");
  r.set({ view: viewFor(current, r.get().view) });
  r.drawReview();
  drawView(r);
};

const read = async (r, id) => {
  const { reader, box } = r.el;

  await r.load();
  r.closeEditor();
  r.set(opened(r.get(), id));

  const { current } = r.get();

  reader.hidden = !current;
  box.classList.toggle("staging-reading", !!current);
  r.drawShelf();
  if (!current) return;
  drawReader(r);
  reader.focus();
};

const back = (r) => {
  r.set({ current: null });
  r.closeEditor();
  r.el.reader.hidden = true;
  r.el.box.classList.remove("staging-reading");
  history.replaceState(null, "", "#emails");
  r.drawShelf();
  r.el.search.focus();
};

const listenViews = (r) => {
  r.el.views.forEach((b) => {
    b.addEventListener("click", () => {
      r.set({ view: b.dataset.stagingView });

      const { current, editing } = r.get();

      if (current && !editing) drawView(r);
    });
  });
};

export const mountReader = (r) => {
  listenViews(r);
  r.qs("[data-staging-reader-back]").addEventListener("click", () => back(r));
  r.qs("[data-staging-copy-link]").addEventListener("click", async (ev) => {
    const link = linkTo(location.origin, r.get().current.id);
    const b = ev.currentTarget;

    try {
      await navigator.clipboard.writeText(link);
      b.textContent = "Copied";
    } catch {
      // eslint-disable-next-line no-alert -- #791 c7102217150: no new UI yet
      prompt("The link to this email:", link);
    }
    setTimeout(() => { b.textContent = "Copy link"; }, 1200);
  });

  return {
    read: (id) => read(r, id),
    drawReader: () => drawReader(r),
    drawView: () => drawView(r),
  };
};
