// An email's subject and text as parts, pure (docs/refactors/
// staging-library.md, phase 2): a part is { text } or { token }, a
// token being one of the sample values (name, order, dates, amounts,
// links) that can be moved or deleted but not changed. The editor's
// content is read back through childNodes, nodeType, nodeName, data
// and dataset alone, so plain objects stand in for it in a test.

// In the editor, a click beside a token can leave the caret inside
// it, where nothing can be typed, so each token is wrapped in
// invisible anchors for the caret to land in. partsOf drops them.
export const ANCHOR = "​";

// A node's nodeType for text.
const TEXT_NODE = 3;

const isToken = (node) => node.dataset && node.dataset.token !== undefined;

// The editor's content back as parts. A browser may wrap new lines
// in <div> or <br> rather than a newline character; both count as
// one.
export const partsOf = (el) => {
  const out = [];
  const add = (text) => {
    const last = out.at(-1);

    if (last && last.text !== undefined) last.text += text;
    else out.push({ text });
  };
  const walk = (node) => {
    for (const child of node.childNodes) visit(child);
  };
  const visit = (child) => {
    if (child.nodeType === TEXT_NODE) {
      add(child.data.replaceAll(ANCHOR, ""));
    } else if (isToken(child)) {
      out.push({ token: child.dataset.token });
    } else if (child.nodeName === "BR") {
      add("\n");
    } else {
      if (/^(DIV|P)$/.test(child.nodeName) && out.length) add("\n");
      walk(child);
    }
  };

  walk(el);

  return out.filter((p) => p.token !== undefined || p.text);
};

export const tokensOf = (parts) => parts
  .filter((p) => p.token !== undefined).map((p) => p.token);

// Which of the original's sample values the rewrite leaves out, once
// each, in the original's order.
export const leftOut = (original, rewrite) => {
  const kept = new Set(tokensOf(rewrite));

  return [...new Set(tokensOf(original).filter((t) => !kept.has(t)))];
};

// The subject as saved: on one line, each newline and the space
// around it one space.
export const oneLine = (parts) => parts
  .map((p) => (p.text === undefined ? p
    : { text: p.text.replace(/\s*\n\s*/g, " ") }));

// The rewrite view: the subject, a blank line, and the text.
export const rewriteParts = ({ subject, text }) => [{ text: "Subject: " },
  ...subject, { text: "\n\n" }, ...text];
