// The space between each two words of an element's text, as drawn
// (#598). Run in the page: `locator.evaluate(wordGaps)`. Whatever the
// markup (a no-break space, or a text-nowrap span around an ordinary
// one), each gap is measured from the last letter before it to the
// first after it, so a space that draws with no width shows as 0.
//
// Returns one entry per gap: the words on each side, its width in px,
// whether the two words share a line, and whether the pair is kept
// together (inside a text-nowrap span, or joined by a no-break space).

export const wordGaps = (root) => {
  // The page runs this alone, so it can't share a constant: the two
  // no-break spaces, U+00A0 and U+202F.
  const nb = String.fromCharCode(0xa0, 0x202f);
  const noBreak = new RegExp(`[${nb}]`);
  const space = new RegExp(`[ \\t\\n${nb}]`);
  const chars = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    for (let i = 0; i < node.data.length; i += 1) {
      chars.push({ node, i, ch: node.data[i] });
    }
  }

  const box = ({ node, i }) => {
    const range = document.createRange();

    range.setStart(node, i);
    range.setEnd(node, i + 1);

    return range.getBoundingClientRect();
  };
  const text = chars.map((c) => c.ch).join("");
  const gaps = [];

  for (let i = 1; i < chars.length - 1; i += 1) {
    if (!space.test(chars[i].ch) || space.test(chars[i - 1].ch)) continue;

    let j = i;

    while (j < chars.length && space.test(chars[j].ch)) j += 1;
    if (j === chars.length) break;

    const before = box(chars[i - 1]);
    const after = box(chars[j]);
    const words = `${text.slice(0, j).split(space).at(-2)} ${
      text.slice(j).split(space)[0]}`;

    // A character with no box (collapsed away) has no gap to measure.
    if (before.width && after.width) {
      gaps.push({
        words: words.replace(new RegExp(`[${nb}]`, "g"), " "),
        width: after.left - before.right,
        sameLine: Math.abs(after.top - before.top) < 2,
        kept: Boolean(chars[i].node.parentElement.closest(".text-nowrap"))
          || noBreak.test(chars[i].ch),
      });
    }
  }

  return gaps;
};
