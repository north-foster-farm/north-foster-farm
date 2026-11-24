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

import { isBusy, onPress, whileBusy } from "../utils/busy-button.js";
import { elementsOf } from "./library/elements.js";
import { leftOut, oneLine, partsOf } from "./library/parts.mjs";
import { mountReader } from "./library/reader.js";
import { hashTarget } from "./library/review.mjs";
import { grouped, wordsOf } from "./library/search.mjs";
import {
  day, drawShelf as showShelf, drawSummary as showSummary,
} from "./library/shelf-view.js";
import { initial, saved as withSaved } from "./library/state.mjs";
import { fill, outOfToken } from "./library/tokens.js";

// The toolbar's line on the library, for staging/main.js.
export { tally } from "./library/search.mjs";

// `canReview` says whether this session may approve and rewrite: James
// alone (#294); everyone else reads.
export const mountLibrary = ({
  root, api, onOpen, canReview = () => false, canSeeSent = () => false,
}) => {
  const qs = (sel) => root.querySelector(sel);
  const el = elementsOf(root);
  const {
    box, shelf, empty, search, reader, tokenTemplate, filters, review,
    editor,
  } = el;
  // The one record (library/state.mjs), and the getter and setter each
  // part is handed. A setter draws nothing: the part that changed the
  // record redraws what it changed.
  let state = initial();
  const get = () => state;
  const set = (over) => {
    state = { ...state, ...over };
  };
  let loading = null;

  // The shelf: the emails by audience, narrowed by the search and the
  // approval filter, and the sent mail for a session that may see it,
  // asked at each drawing.
  const drawShelf = () => showShelf(el, grouped({
    emails: state.emails, sent: state.sent, words: wordsOf(search.value),
    approval: state.approval, canSeeSent: canSeeSent(),
  }), state.current);

  const drawSummary = () => showSummary(el, state.emails);

  const load = () => {
    loading = loading || api("/api/staging/emails").then(async ({
      ok, data,
    }) => {
      set({ emails: ok ? data.emails : [] });
      if (ok && canSeeSent()) {
        const got = await api("/api/staging/sent");

        set({ sent: got.ok ? got.data.messages : [] });
      }
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

  // The caret kept out of a token while the editor is open.
  document.addEventListener("selectionchange",
    () => outOfToken(state.editing, editor.form));

  // --- The open email ------------------------------------------------

  const drawReview = () => {
    const e = state.current;
    const byCode = e.approvedBy === "code";
    const show = {
      approve: e.approval === "to approve",
      rewrite: e.approval === "to approve" || e.approval === "rewritten",
      withdraw: e.approval === "approved" && !byCode,
      revert: e.approval === "rewritten",
    };

    review.bar.hidden = !canReview() || byCode || !!e.error;
    for (const [name, on] of Object.entries(show)) {
      review[name].hidden = !on || state.editing;
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

  const closeEditor = () => {
    set({ editing: false });
    editor.form.hidden = true;
  };

  // The reader (library/reader.js): read, the views, Back, Copy link.
  const { read, drawReader, drawView } = mountReader({
    el, qs, api, get, set, load, drawShelf, drawReview, closeEditor,
  });

  // A review saved: the server's answer replaces the email everywhere
  // it shows, without a reload.
  const saved = (email) => {
    set(withSaved(state, email));
    drawSummary();
    drawShelf();
    drawReader();
  };

  const send = async (kind, method, body, errorEl) => {
    const path = `/api/staging/emails/${
      encodeURIComponent(state.current.id)}/${kind}`;
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
    const { current } = state;
    const from = current.approval === "rewritten"
      ? current.rewrite : current.parts;

    fill(tokenTemplate, editor.subject, from.subject, true);
    fill(tokenTemplate, editor.text, from.text, true);
    for (const el of [editor.subject, editor.text]) {
      try {
        el.contentEditable = "plaintext-only";
      } catch {
        el.contentEditable = "true";
      }
    }
    editor.dropped.hidden = true;
    editor.error.hidden = true;
    set({ editing: true });
    editor.form.hidden = false;
    drawReview();
    drawView();
    editor.text.focus();
  };

  // Which of the email's sample values the rewrite leaves out.
  const noteDropped = () => {
    const { parts } = state.current;
    const gone = leftOut([...parts.subject, ...parts.text],
      [...partsOf(editor.subject), ...partsOf(editor.text)]);

    editor.dropped.textContent = gone.length
      ? `Left out: ${gone.join(", ")}` : "";
    editor.dropped.hidden = !gone.length;
  };

  onPress(review.approve, () => send("approval", "PUT",
    { version: state.current.version }, review.error));
  onPress(review.withdraw, () => send("approval",
    "DELETE", undefined, review.error));
  onPress(review.revert, async () => {
    // eslint-disable-next-line no-alert -- #791 c7102217150: pinned by e2e
    if (!confirm("Drop your rewrite and keep the current wording?")) return;
    set({ view: "html" });
    await send("rewrite", "DELETE", undefined, review.error);
  });
  review.rewrite.addEventListener("click", openEditor);
  editor.subject.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") ev.preventDefault();
  });
  editor.form.addEventListener("input", noteDropped);
  editor.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();

    const button = editor.form.querySelector(".busy-button");

    if (isBusy(button)) return;
    editor.error.hidden = true;

    const subject = oneLine(partsOf(editor.subject));
    const ok = await whileBusy(button, send("rewrite", "PUT", {
      version: state.current.version, subject, text: partsOf(editor.text),
    }, editor.error));

    if (ok) {
      closeEditor();
      set({ view: "rewrite" });
      drawReader();
    }
  });
  qs("[data-staging-edit-cancel]").addEventListener("click", () => {
    closeEditor();
    drawReview();
    drawView();
  });

  // --- Opening and closing -------------------------------------------

  // Focus goes into the library on open (the search, or the open
  // email) and back to whatever opened it on close (#357), so a
  // keyboard user never lands at the top of the page.
  let opener = null;

  const open = (id = null) => {
    onOpen();
    opener = document.activeElement;
    box.hidden = false;
    document.documentElement.classList.add("staging-library-open");
    load();
    if (id) read(id);
    else if (state.current) reader.focus();
    else search.focus();
  };

  const close = () => {
    box.hidden = true;
    document.documentElement.classList.remove("staging-library-open");
    if (/^#emails?\b/.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    if (opener && opener.focus) opener.focus();
    opener = null;
  };

  // #email=<id> opens that email, #emails the shelf (library/review.mjs).
  const fromHash = () => {
    const target = hashTarget(location.hash);

    if (target) open(target.id);
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
  search.addEventListener("input", () => state.emails && drawShelf());
  filters.forEach((b) => {
    b.addEventListener("click", () => {
      set({ approval: b.dataset.stagingFilter });
      for (const f of filters) {
        f.setAttribute("aria-pressed", String(f === b));
      }
      if (state.emails) drawShelf();
    });
  });
  // The toolbar's button is a link that opens #emails in a new tab.
  for (const b of root.querySelectorAll("[data-staging-library-close]")) {
    b.addEventListener("click", close);
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !box.hidden && !state.editing) close();
  });
  window.addEventListener("hashchange", fromHash);

  // The count on the toolbar's button, without opening anything.
  const counted = () => load();

  return { fromHash, counted };
};
