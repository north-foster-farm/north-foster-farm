// The Signatures panel: every email signature variant, previewed as a
// mail app will show it, with a Copy button that puts exactly that
// signature on the clipboard (rich HTML with plain text beside it) and
// an Open alone link to a page holding nothing else, for Select All
// and Copy where the Clipboard API is refused (#267). The variants and
// their HTML come from /api/staging/signatures; nothing here sends
// mail.

const PREVIEW = (html) => `<!doctype html><meta charset="utf-8">` +
  `<base target="_blank"><body style="margin:12px;background:#fff">${html}`;

export const mountSignatures = ({ root, api, aloneUrl }) => {
  const list = root.querySelector("[data-staging-signatures]");
  const note = root.querySelector("[data-staging-signatures-note]");
  const item = root.querySelector("[data-staging-signature]");

  const copy = async (s, said) => {
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

  const draw = (signatures) => {
    list.replaceChildren();
    for (const s of signatures) {
      const li = item.content.firstElementChild.cloneNode(true);
      const gap = li.querySelector(".staging-signature-gap");
      const said = li.querySelector("[data-signature-said]");

      li.querySelector(".staging-signature-label").textContent = s.label;
      li.querySelector("iframe").srcdoc = PREVIEW(s.html);
      if (s.missing.length) {
        gap.textContent = `placeholder: ${s.missing.join(", ")}`;
        gap.hidden = false;
      }
      li.querySelector("[data-signature-copy]")
        .addEventListener("click", () => copy(s, said));
      li.querySelector("[data-signature-alone]").href = aloneUrl(s.id);
      list.appendChild(li);
    }
  };

  const load = async () => {
    const { ok, data } = await api("/api/staging/signatures");

    if (!ok) {
      note.textContent = "The signatures could not be loaded.";

      return;
    }
    draw(data.signatures);
    note.textContent = "Bracketed gaps are details James has not given yet.";
  };

  return { load };
};
