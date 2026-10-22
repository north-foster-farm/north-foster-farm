// A TrueType font read from a WOFF file (#292), for the PDF writer to
// embed: the font file itself and the few numbers a PDF wants about
// it. WOFF 1.0 only, whose tables are each zlib-compressed or stored;
// WOFF2's transformed glyph tables would take far more code.
//
//   const font = readWoff(buffer);
//   font.advance(0x41)   // the width of "A", in thousandths of the size

import { inflateSync } from "node:zlib";

const tag = (b, at) => b.toString("latin1", at, at + 4);

// The sfnt's tables, by tag, from a WOFF 1.0 file.
const woffTables = (woff) => {
  if (tag(woff, 0) !== "wOFF") throw new Error("ttf: not a WOFF 1.0 file");
  if (woff.readUInt32BE(4) !== 0x00010000) {
    throw new Error("ttf: not a TrueType font");
  }

  const tables = new Map();

  for (let i = 0, n = woff.readUInt16BE(12); i < n; i += 1) {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const stored = woff.subarray(offset, offset + woff.readUInt32BE(at + 8));
    const length = woff.readUInt32BE(at + 12);

    tables.set(tag(woff, at), {
      data: stored.length < length ? inflateSync(stored) : stored,
      checksum: woff.readUInt32BE(at + 16),
    });
  }

  return tables;
};

// The tables back into one TrueType file, each on a 4-byte boundary.
const sfnt = (tables) => {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  const log2 = Math.floor(Math.log2(n));
  const head = Buffer.alloc(12 + n * 16);
  const parts = [head];
  let offset = head.length;

  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(n, 4);
  head.writeUInt16BE(16 * 2 ** log2, 6);
  head.writeUInt16BE(log2, 8);
  head.writeUInt16BE(n * 16 - 16 * 2 ** log2, 10);
  tags.forEach((t, i) => {
    const { data, checksum } = tables.get(t);
    const at = 12 + i * 16;

    head.write(t, at, "latin1");
    head.writeUInt32BE(checksum, at + 4);
    head.writeUInt32BE(offset, at + 8);
    head.writeUInt32BE(data.length, at + 12);
    parts.push(data, Buffer.alloc((4 - (data.length % 4)) % 4));
    offset += data.length + ((4 - (data.length % 4)) % 4);
  });

  return Buffer.concat(parts);
};

// Unicode -> glyph id, from the Windows Unicode cmap (format 4).
const glyphMap = (cmap) => {
  let sub = null;

  for (let i = 0, n = cmap.readUInt16BE(2); i < n; i += 1) {
    const at = 4 + i * 8;

    if (cmap.readUInt16BE(at) === 3 && cmap.readUInt16BE(at + 2) === 1) {
      sub = cmap.readUInt32BE(at + 4);
    }
  }
  if (sub === null || cmap.readUInt16BE(sub) !== 4) {
    throw new Error("ttf: no Windows Unicode cmap");
  }

  const segs = cmap.readUInt16BE(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;

  return (code) => {
    for (let s = 0; s < segs; s += 1) {
      if (code > cmap.readUInt16BE(ends + s * 2)) continue;

      const start = cmap.readUInt16BE(starts + s * 2);

      if (code < start) return 0;

      const delta = cmap.readInt16BE(deltas + s * 2);
      const range = cmap.readUInt16BE(ranges + s * 2);

      if (!range) return (code + delta) & 0xffff;

      const at = ranges + s * 2 + range + (code - start) * 2;
      const glyph = cmap.readUInt16BE(at);

      return glyph ? (glyph + delta) & 0xffff : 0;
    }

    return 0;
  };
};

// The PostScript name (name id 6), from the Windows or Mac record.
const postscriptName = (name) => {
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);

  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 12;

    if (name.readUInt16BE(at + 6) !== 6) continue;

    const platform = name.readUInt16BE(at);
    const length = name.readUInt16BE(at + 8);
    const start = strings + name.readUInt16BE(at + 10);
    const raw = name.subarray(start, start + length);

    if (platform === 3) return Buffer.from(raw).swap16().toString("utf16le");
    if (platform === 1) return raw.toString("latin1");
  }

  return null;
};

// -> { name, file, advance(code), ascent, descent, capHeight, bbox,
// italicAngle, bold }: widths and heights in thousandths of the size.
// Throws when the font's licence bits forbid embedding it.
export const readWoff = (woff) => {
  const tables = woffTables(woff);
  const table = (t) => {
    if (!tables.has(t)) throw new Error(`ttf: no ${t} table`);

    return tables.get(t).data;
  };
  const head = table("head");
  const hhea = table("hhea");
  const hmtx = table("hmtx");
  const os2 = table("OS/2");
  const post = table("post");
  const upm = head.readUInt16BE(18);
  const scale = (v) => Math.round(v * 1000 / upm);
  const metrics = hhea.readUInt16BE(34);
  const glyphOf = glyphMap(table("cmap"));

  // Restricted licence: bit 1 alone, with no looser bit beside it.
  if ((os2.readUInt16BE(8) & 0x000f) === 0x0002) {
    throw new Error("ttf: the font's licence forbids embedding it");
  }

  return {
    name: postscriptName(table("name")) || "Font",
    file: sfnt(tables),
    advance: (code) => {
      const g = Math.min(glyphOf(code), metrics - 1);

      return scale(hmtx.readUInt16BE(g * 4));
    },
    ascent: scale(os2.readInt16BE(68)),
    descent: scale(os2.readInt16BE(70)),
    capHeight: scale(os2.readUInt16BE(0) >= 2 ? os2.readInt16BE(88)
      : os2.readInt16BE(68)),
    bbox: [36, 38, 40, 42].map((at) => scale(head.readInt16BE(at))),
    italicAngle: post.readInt16BE(4) + post.readUInt16BE(6) / 65536,
    bold: os2.readUInt16BE(4) >= 600,
  };
};
