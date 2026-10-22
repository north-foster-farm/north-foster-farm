// The Square sandbox card (#294 §4): the copy buttons beside its
// details, in the toolbar and in the order page's first-visit overlay,
// and the overlay itself.
//
// The overlay shows once per gate session. Its flag lives in this
// browser's localStorage under SEEN, holding the session's short name
// from /api/staging/info: a new gate session (signing in again)
// shows it again, and so does the toolbar's "Reset to first visit",
// which clears localStorage (reset.js keeps only the toolbar's own
// open state).

export const SEEN = "staging.card-seen";

const COPIED_MS = 1600;

const read = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key, value) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is off: the overlay shows on each order page instead.
  }
};

// Every copy button on the page, toolbar and overlay alike.
export const wireCopy = (doc = document) => {
  doc.addEventListener("click", async (ev) => {
    const button = ev.target.closest && ev.target.closest(
      "[data-staging-copy]"
    );

    if (!button) return;

    const said = button.parentElement.querySelector(".staging-copied");

    try {
      await navigator.clipboard.writeText(button.dataset.stagingCopy);
      said.textContent = "Copied";
    } catch {
      said.textContent = "Copy failed: select it instead";
    }
    clearTimeout(button.copiedTimer);
    button.copiedTimer = setTimeout(() => {
      said.textContent = "";
    }, COPIED_MS);
  });
};

// Shows the overlay on the order page the first time in this session.
// It is a modal <dialog>: the page behind is inert and focus stays in
// it; the page does not scroll; Escape or Close ends it, and focus goes
// back to the page.
export const maybeShowOverlay = ({ session, doc = document }) => {
  const dialog = doc.querySelector("[data-staging-card-dialog]");

  if (!dialog || !session) return false;
  if (!/^\/order\/?$/.test(doc.location.pathname)) return false;
  if (read(SEEN) === session) return false;

  const html = doc.documentElement;
  const before = doc.activeElement;

  dialog.addEventListener("close", () => {
    write(SEEN, session);
    html.classList.remove("staging-modal-open");
    const back = before && before !== doc.body && before.isConnected
      ? before : doc.querySelector("main") || doc.body;

    if (back === doc.querySelector("main") && !back.hasAttribute("tabindex")) {
      back.setAttribute("tabindex", "-1");
    }
    back.focus({ preventScroll: true });
  }, { once: true });
  dialog.querySelector("[data-staging-card-close]")
    .addEventListener("click", () => dialog.close());

  html.classList.add("staging-modal-open");
  dialog.showModal();

  return true;
};
