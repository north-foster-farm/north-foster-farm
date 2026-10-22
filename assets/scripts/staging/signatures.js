// The signature library: every email signature variant listed in a
// sidebar, the open one previewed as a mail app will show it, with a
// Copy button that puts exactly that signature on the clipboard (rich
// HTML with plain text beside it) and an Open alone link to a page
// holding nothing else, for Select All and Copy where the Clipboard API
// is refused (#267). It is a view of its own, apart from the email
// library, though it borrows that view's look. The variants and their
// HTML come from /api/staging/signatures; nothing here sends mail.
//
// #signature=<id> on any page opens the library at that variant;
// #signatures opens it at the top.

const PREVIEW = (html) => `<!doctype html><meta charset="utf-8">` +
  `<base target="_blank"><body style="margin:12px;background:#fff">${html}`;

const HINT = "Copy puts this signature on the clipboard as rich text, " +
  "with plain text beside it.";

const NARROW = "(max-width: 47.99rem)";

export const mountSignatures = ({ root, api, aloneUrl, onOpen }) => {
  const qs = (sel) => root.querySelector(sel);
  const box = qs("[data-staging-sigs]");
  const list = qs("[data-staging-sigs-list]");
  const empty = qs("[data-staging-sigs-empty]");
  const summary = qs("[data-staging-sigs-summary]");
  const count = qs("[data-staging-sigs-count]");
  const reader = qs("[data-staging-sigs-reader]");
  const frame = qs("[data-staging-sigs-frame]");
  const name = qs("[data-staging-sigs-name]");
  const gap = qs("[data-staging-sigs-gap]");
  const said = qs("[data-signature-said]");
  const alone = qs("[data-signature-alone]");
  const item = qs("[data-staging-sigs-item]");
  let signatures = null;
  let current = null;

  const copy = async (s) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([s.html], { type: "text/html" }),
        "text/plain": new Blob([s.text], { type: "text/plain" }),
      })]);
      said.textContent = "Copied.";
    } catch {
      said.textContent = "This browser refused. Use Open alone.";
    }
  };

  const drawList = () => {
    list.replaceChildren();
    for (const s of signatures) {
      const li = item.content.firstElementChild.cloneNode(true);
      const a = li.querySelector("a");
      const badge = li.querySelector(".staging-badge");

      a.href = `#signature=${encodeURIComponent(s.id)}`;
      a.dataset.id = s.id;
      if (current && current.id === s.id) {
        a.setAttribute("aria-current", "true");
      }
      li.querySelector(".staging-item-name").textContent = s.label;
      if (s.missing.length) {
        badge.textContent = "has placeholders";
        badge.hidden = false;
      }
      list.appendChild(li);
    }
    summary.textContent = `${signatures.length} variants`;
  };

  const read = (id) => {
    const s = signatures && signatures.find((x) => x.id === id);

    if (!s) return;
    current = s;
    name.textContent = s.label;
    frame.srcdoc = PREVIEW(s.html);
    said.textContent = HINT;
    gap.hidden = !s.missing.length;
    gap.textContent = `placeholder: ${s.missing.join(", ")}`;
    alone.href = aloneUrl(s.id);
    reader.hidden = false;
    box.classList.add("staging-reading");
    drawList();
  };

  const load = async () => {
    if (signatures) return;

    const { ok, data } = await api("/api/staging/signatures");

    empty.hidden = ok;
    if (!ok) return;
    signatures = data.signatures;
    count.textContent = `Variants: ${signatures.length}`;
    drawList();
  };

  const open = async (id = null) => {
    onOpen();
    box.hidden = false;
    document.documentElement.classList.add("staging-library-open");
    await load();
    if (!signatures) return;
    if (id) read(id);
    else if (!current && !window.matchMedia(NARROW).matches) {
      read(signatures[0].id);
    }
  };

  const close = () => {
    box.hidden = true;
    document.documentElement.classList.remove("staging-library-open");
    if (/^#signatures?\b/.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  };

  const fromHash = () => {
    const m = location.hash.match(/^#signature=([^&]+)/);

    if (m) open(decodeURIComponent(m[1]));
    else if (location.hash === "#signatures") open();
  };

  list.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-id]");

    if (!a) return;
    ev.preventDefault();
    history.replaceState(null, "", a.getAttribute("href"));
    read(a.dataset.id);
  });
  qs("[data-signature-copy]").addEventListener("click", () => {
    if (current) copy(current);
  });
  qs("[data-staging-sigs-back]").addEventListener("click", () => {
    current = null;
    reader.hidden = true;
    box.classList.remove("staging-reading");
    history.replaceState(null, "", "#signatures");
    drawList();
  });
  qs("[data-staging-sigs-open]").addEventListener("click", () => open());
  qs("[data-staging-sigs-close]").addEventListener("click", close);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !box.hidden) close();
  });
  window.addEventListener("hashchange", fromHash);

  // The count on the toolbar's button, without opening anything.
  return { fromHash, counted: load };
};
