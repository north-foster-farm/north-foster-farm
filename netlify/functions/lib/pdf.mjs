// A small PDF writer for the packing slips (#292): US Letter pages of
// text, rules, boxes and filled vector art. Text is in the two
// standard Helvetica faces, which every PDF reader carries, or in the
// site's Aller, regular and bold, embedded whole in the file only
// when a page uses it. Text is WinAnsi (Windows-1252); a character
// outside it prints as "?". A colour is a gray level (0 black, 1
// white) or "#rrggbb". The output is the same bytes for the same
// calls.
//
//   const doc = pdf({ title: "Packing slips" });
//   doc.page();
//   doc.text("Hello", 54, 72, { size: 12, bold: true, font: "aller" });
//   const bytes = doc.bytes();   // a Buffer
//
// Coordinates are points from the top left of the page; `y` is the
// text's baseline.

import { deflateSync } from "node:zlib";

import * as assets from "./slip-assets.mjs";
import { readWoff } from "./ttf.mjs";

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

// The character each WinAnsi code stands for, 32..255; null for the
// five codes 1252 leaves empty.
const CODE_CHARS = Array.from({ length: 224 }, (_, i) => {
  const c = i + 32;

  if (c <= 126 || c >= 0xa0) return String.fromCharCode(c);

  return Object.keys(HIGH).find((ch) => HIGH[ch] === c) || null;
});

// Aller, read from its WOFF files the first time a slip needs it.
let aller = null;

const allerFaces = () => {
  // Each face's file compressed once, as every PDF embeds it the same.
  const face = (b64) => {
    const font = readWoff(Buffer.from(b64, "base64"));

    return { ...font, packed: deflateSync(font.file).toString("latin1") };
  };

  aller ||= { regular: face(assets.regular), bold: face(assets.bold) };

  return aller;
};

// A face: "F1" Helvetica, "F2" its bold, "F3" Aller, "F4" its bold.
const faceOf = ({ bold = false, font = "helvetica" } = {}) => {
  if (font === "aller") return bold ? "F4" : "F3";
  if (font !== "helvetica") throw new Error(`pdf: no font ${font}`);

  return bold ? "F2" : "F1";
};

// A Helvetica width for a character outside ASCII: its own from WIDE,
// or its base letter's, or a figure's.
const helveticaWide = (ch, bold) => {
  const base = ch.normalize("NFD")[0];

  return WIDE[ch] ? WIDE[ch][bold ? 1 : 0]
    : base !== ch && base.codePointAt(0) <= 126 ? charWidth(base, bold
      ? "F2" : "F1")
      : 556;
};

// A width outside ASCII, worked out once: a Helvetica one's normal
// form is the costly part.
const wideCache = new Map();

function charWidth(ch, face) {
  const c = ch.codePointAt(0);

  if (c >= 32 && c <= 126 && face === "F1") return REGULAR[c - 32];
  if (c >= 32 && c <= 126 && face === "F2") return BOLD[c - 32];

  const key = `${face}${ch}`;

  if (!wideCache.has(key)) {
    wideCache.set(key, face === "F3" || face === "F4"
      ? allerFaces()[face === "F4" ? "bold" : "regular"].advance(c)
      : helveticaWide(ch, face === "F2"));
  }

  return wideCache.get(key);
}

// The width of already printable text, in points.
const measure = (chars, size, face) =>
  chars.reduce((w, ch) => w + charWidth(ch, face), 0) * size / 1000;

// The width of `text` in points.
export const widthOf = (text, { size = 10, ...font } = {}) =>
  measure([...printable(text)], size, faceOf(font));

export const ELLIPSIS = "…";

// `text` broken into lines no wider than `width`, at spaces where it
// can be and mid-word where a word alone is too wide. Each character
// is measured once, so a long note costs no more than its length.
// With `rows`, text past that many lines is cut and the last line
// ends in an ellipsis.
export const wrap = (text, width, {
  size = 10, rows = Infinity, ...font
} = {}) => {
  const face = faceOf(font);
  const w = (ch) => charWidth(ch, face) * size / 1000;
  const space = w(" ");
  const lines = [];
  let line = [];
  let lineWidth = 0;
  const flush = () => {
    lines.push(line.join(""));
    line = [];
    lineWidth = 0;
  };

  for (const word of printable(text).split(" ").filter(Boolean)) {
    const chars = [...word];
    const wordWidth = chars.reduce((s, ch) => s + w(ch), 0);

    if (wordWidth > width) {
      // Too wide alone: cut it where the line fills, at least one
      // character a line so even a too-wide glyph moves on.
      if (line.length) flush();
      for (const ch of chars) {
        if (line.length && lineWidth + w(ch) > width) flush();
        line.push(ch);
        lineWidth += w(ch);
      }
      continue;
    }
    if (line.length && lineWidth + space + wordWidth > width) flush();
    if (line.length) {
      line.push(" ");
      lineWidth += space;
    }
    line.push(...chars);
    lineWidth += wordWidth;
  }
  if (line.length || !lines.length) flush();
  if (lines.length <= rows) return lines;

  const kept = lines.slice(0, rows);
  const last = [...kept[rows - 1]];
  const room = width - w(ELLIPSIS);
  let lastWidth = measure(last, size, face);

  while (last.length && lastWidth > room) lastWidth -= w(last.pop());
  kept[rows - 1] = `${last.join("").trimEnd()}${ELLIPSIS}`;

  return kept;
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

// A colour as a fill (`stroke` false) or a stroke operator.
const paint = (color, stroke = false) => {
  if (typeof color === "number") return `${num(color)} ${stroke ? "G" : "g"}`;

  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);

  if (!m) throw new Error(`pdf: no colour ${color}`);

  return `${m.slice(1).map((h) => num(parseInt(h, 16) / 255)).join(" ")} ${
    stroke ? "RG" : "rg"}`;
};

// An embedded TrueType face: its font, descriptor and file objects.
const embed = (add, face) => {
  const stream = add(`<< /Length ${face.packed.length} /Length1 ${
    face.file.length} /Filter /FlateDecode >>\nstream\n${
    face.packed}\nendstream`);
  const descriptor = add(`<< /Type /FontDescriptor /FontName /${
    face.name} /Flags ${face.italicAngle ? 96 : 32} /FontBBox [${
    face.bbox.join(" ")}] /ItalicAngle ${num(face.italicAngle)} /Ascent ${
    face.ascent} /Descent ${face.descent} /CapHeight ${
    face.capHeight} /StemV ${face.bold ? 140 : 80} /FontFile2 ${
    stream} 0 R >>`);
  const widths = CODE_CHARS.map((ch) => (ch ? face.advance(
    ch.codePointAt(0)) : 0));

  return add(`<< /Type /Font /Subtype /TrueType /BaseFont /${
    face.name} /FirstChar 32 /LastChar 255 /Widths [${widths.join(" ")
  }] /Encoding /WinAnsiEncoding /FontDescriptor ${descriptor} 0 R >>`);
};

export const pdf = ({ title = "", size = LETTER } = {}) => {
  const pages = [];
  const used = new Set();
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

    // `align` is left, right (x is the right edge) or center. `shade`
    // is the older name for a gray `color`.
    text(value, x, top, {
      size: pt = 10, bold = false, font = "helvetica", align = "left",
      shade = 0, color = shade,
    } = {}) {
      need();

      const face = faceOf({ bold, font });
      const w = widthOf(value, { size: pt, bold, font });
      const left = align === "right" ? x - w : align === "center"
        ? x - w / 2 : x;

      used.add(face);
      ops.push(`BT ${paint(color)} /${face} ${num(pt)} Tf ${
        num(left)} ${num(y(top))} Td ${literal(value)} Tj ET 0 g`);
    },

    line(x1, top1, x2, top2, { width = 0.75, shade = 0, color = shade } = {}) {
      need();
      ops.push(`${num(width)} w ${paint(color, true)} ${num(x1)} ${
        num(y(top1))} m ${num(x2)} ${num(y(top2))} l S 0 G`);
    },

    // A box from its top left. `fill` is a colour, or null for none;
    // `stroke` a line width, or 0 for none, in `color`.
    rect(x, top, w, h, { fill = null, stroke = 0.75, color = 0 } = {}) {
      need();

      const box = `${num(x)} ${num(y(top + h))} ${num(w)} ${num(h)} re`;

      if (fill !== null) ops.push(`${paint(fill)} ${box} f 0 g`);
      if (stroke) {
        ops.push(`${num(stroke)} w ${paint(color, true)} ${box} S 0 G`);
      }
    },

    // Vector art ({ box: [x, y, w, h] in its own units, ops: PDF path
    // operators in them, y downward as in SVG }) drawn `height` points
    // tall from its top left. -> its width in points.
    art({ box: [bx, by, bw, bh], ops: path }, x, top, {
      height, color = 0,
    }) {
      need();

      const s = height / bh;

      ops.push(`q ${num(s)} 0 0 ${num(-s)} ${num(x - bx * s)} ${
        num(y(top) + by * s)} cm ${paint(color)} ${path} Q`);

      return bw * s;
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
      const fonts = {
        F1: add("<< /Type /Font /Subtype /Type1 " +
          "/BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
        F2: add("<< /Type /Font /Subtype /Type1 " +
          "/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
      };

      if (used.has("F3")) fonts.F3 = embed(add, allerFaces().regular);
      if (used.has("F4")) fonts.F4 = embed(add, allerFaces().bold);

      const resources = `<< /Font << ${Object.entries(fonts)
        .map(([name, id]) => `/${name} ${id} 0 R`).join(" ")} >> >>`;
      const kids = [];

      for (const page of pages) {
        const stream = page.join("\n");
        const content = add(`<< /Length ${
          Buffer.byteLength(stream, "latin1")} >>\nstream\n${
          stream}\nendstream`);

        kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${
          size.width} ${size.height}] /Resources ${resources} /Contents ${
          content} 0 R >>`));
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
