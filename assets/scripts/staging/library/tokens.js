// The library's tokens drawn (docs/refactors/staging-library.md,
// phase 2): parts.mjs's parts as text and token spans, each span from
// the [data-staging-token] template, and the caret kept out of a
// token in the editor.

import { ANCHOR } from "./parts.mjs";

const token = (template, value) => {
  const span = template.content.firstElementChild.cloneNode(true);

  span.textContent = value;
  span.dataset.token = value;

  return span;
};

// The element's content replaced by the parts. For the editor,
// `anchored` wraps each token in ANCHORs.
export const fill = (template, el, parts, anchored = false) => {
  const anchor = () => document.createTextNode(ANCHOR);

  el.replaceChildren(...parts.flatMap((p) => {
    if (p.token === undefined) return [document.createTextNode(p.text)];

    const span = token(template, p.token);

    return anchored ? [anchor(), span, anchor()] : [span];
  }));
};

// A click past the end of a line that ends in a token leaves the
// caret inside the token, where typing does nothing. Move it to the
// anchor on the nearer side, for a token inside the editor's form
// while the editor is open.
export const outOfToken = (editing, form) => {
  const s = getSelection();

  if (!editing || !s.rangeCount || !s.isCollapsed) return;

  const node = s.anchorNode;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  const tok = el.closest && el.closest("[data-token]");

  if (!tok || !form.contains(tok)) return;

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
