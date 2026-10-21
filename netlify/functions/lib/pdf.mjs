// A small PDF writer for the packing slips (#292): US Letter pages of
// text, rules and boxes in the two standard Helvetica faces, which
// every PDF reader carries, so nothing is embedded and nothing is
// installed. Text is WinAnsi (Windows-1252); a character outside it
// prints as "?". The output is the same bytes for the same calls.
//
//   const doc = pdf({ title: "Packing slips" });
//   doc.page();
//   doc.text("Hello", 54, 72, { size: 12, bold: true });
//   const bytes = doc.bytes();   // a Buffer
//
// Coordinates are points from the top left of the page; `y` is the
// text's baseline.

export const LETTER = { width: 612, height: 792 };

// The Adobe metrics for 32..126, in thousandths of the size.
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333,
  278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
  584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
  500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556,
  278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333,
  278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333,
  584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
  556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556,
  333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Windows-1252's 0x80..0x9f; 0xa0..0xff are Latin-1's own.
const HIGH = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86,
  "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

// Widths of the 1252 characters the slips are likely to meet; any
// other accented letter takes its base letter's width.
const WIDE = {
  "–": [556, 556], "—": [1000, 1000], "•": [350, 350], "…": [1000, 1000],
  "‘": [222, 278], "’": [222, 278], "“": [333, 500], "”": [333, 500],
  "×": [584, 584], "°": [400, 400], "½": [834, 834], "¼": [834, 834],
  "¾": [834, 834], "\u00a0": [278, 278], "€": [556, 556],
};

// One character -> its WinAnsi code, or null.
const codeOf = (ch) => {
  const c = ch.codePointAt(0);

  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;

  return HIGH[ch] ?? null;
};

// Plain text in, printable WinAnsi out: line breaks and tabs become
// spaces, anything 1252 cannot hold becomes "?".
export const printable = (value) => [...String(value ?? "")
  .replace(/[\t\r\n\u2028\u2029]+/g, " ")]
  .map((ch) => (codeOf(ch) === null ? "?" : ch)).join("");

const charWidth = (ch, bold) => {
  const c = ch.codePointAt(0);

  if (c >= 32 && c <= 126) return (bold ? BOLD : REGULAR)[c - 32];
  if (WIDE[ch]) return WIDE[ch][bold ? 1 : 0];

  const base = ch.normalize("NFD")[0];

  if (base !== ch && base.codePointAt(0) <= 126) return charWidth(base, bold);

  return 556;
};

// The width of `text` in points.
export const widthOf = (text, { size = 10, bold = false } = {}) =>
  [...printable(text)].reduce((w, ch) => w + charWidth(ch, bold), 0)
    * size / 1000;

// `text` broken into lines no wider than `width`, at spaces where it
// can be and mid-word where a word alone is too wide.
export const wrap = (text, width, style = {}) => {
  const words = printable(text).split(" ").filter(Boolean);
  const lines = [];
  let line = "";

  for (let word of words) {
    while (widthOf(word, style) > width) {
      let cut = word.length - 1;

      while (cut > 1 && widthOf(word.slice(0, cut), style) > width) cut--;
      if (line) lines.push(line);
      lines.push(word.slice(0, cut));
      line = "";
      word = word.slice(cut);
    }

    const next = line ? `${line} ${word}` : word;

    if (widthOf(next, style) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line || !lines.length) lines.push(line);

  return lines;
};

// A PDF literal string, in WinAnsi bytes.
const literal = (text) => `(${[...printable(text)].map((ch) => {
  const c = codeOf(ch);

  if (ch === "(" || ch === ")" || ch === "\\") return `\\${ch}`;

  return c > 126 ? `\\${c.toString(8).padStart(3, "0")}` : ch;
}).join("")})`;

const num = (n) => {
  const r = Math.round(n * 100) / 100;

  return Object.is(r, -0) ? "0" : String(r);
};

const gray = (level) => `${num(level)} g`;

export const pdf = ({ title = "", size = LETTER } = {}) => {
  const pages = [];
  let ops = null;
  const y = (top) => size.height - top;
  const need = () => {
    if (!ops) throw new Error("pdf: call page() first");
  };

  return {
    size,
    get pageCount() {
      return pages.length;
    },

    page() {
      ops = [];
      pages.push(ops);
    },

    // `align` is left, right (x is the right edge) or center.
    text(value, x, top, {
      size: pt = 10, bold = false, align = "left", shade = 0,
    } = {}) {
      need();

      const w = widthOf(value, { size: pt, bold });
      const left = align === "right" ? x - w : align === "center"
        ? x - w / 2 : x;

      ops.push(`BT ${gray(shade)} /${bold ? "F2" : "F1"} ${num(pt)} Tf ${
        num(left)} ${num(y(top))} Td ${literal(value)} Tj ET`);
    },

    line(x1, top1, x2, top2, { width = 0.75, shade = 0 } = {}) {
      need();
      ops.push(`${num(width)} w ${shade} G ${num(x1)} ${num(y(top1))} m ${
        num(x2)} ${num(y(top2))} l S`);
    },

    // A box from its top left. `fill` is a gray level (0 black, 1
    // white); `stroke` a line width, or 0 for none.
    rect(x, top, w, h, { fill = null, stroke = 0.75 } = {}) {
      need();

      const box = `${num(x)} ${num(y(top + h))} ${num(w)} ${num(h)} re`;

      if (fill !== null) ops.push(`${gray(fill)} ${box} f 0 g`);
      if (stroke) ops.push(`${num(stroke)} w 0 G ${box} S`);
    },

    bytes() {
      if (!pages.length) this.page();

      const objects = [];
      const add = (body) => {
        objects.push(body);

        return objects.length;
      };
      const catalog = add(null);
      const tree = add(null);
      const regular = add("<< /Type /Font /Subtype /Type1 " +
        "/BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
      const bold = add("<< /Type /Font /Subtype /Type1 " +
        "/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
      const kids = [];

      for (const page of pages) {
        const stream = page.join("\n");
        const content = add(`<< /Length ${
          Buffer.byteLength(stream, "latin1")} >>\nstream\n${
          stream}\nendstream`);

        kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${
          size.width} ${size.height}] /Resources << /Font << /F1 ${
          regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
      }
      objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
      objects[tree - 1] = `<< /Type /Pages /Kids [${
        kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

      const info = add(`<< /Title ${literal(title)} >>`);
      let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
      const offsets = [];

      objects.forEach((body, i) => {
        offsets.push(Buffer.byteLength(out, "latin1"));
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      });

      const xref = Buffer.byteLength(out, "latin1");

      out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const at of offsets) {
        out += `${String(at).padStart(10, "0")} 00000 n \n`;
      }
      out += `trailer\n<< /Size ${objects.length + 1} /Root ${
        catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

      return Buffer.from(out, "latin1");
    },
  };
};
