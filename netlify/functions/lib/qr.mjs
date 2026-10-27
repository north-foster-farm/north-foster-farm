// A QR code for a buying group's join link (#495), drawn as SVG on the
// server so the host's download is the code in force. Written here,
// not taken from a package: the site adds no dependency for one image.
//
// QR Code Model 2 (ISO/IEC 18004), byte mode, error correction level
// M (about 15% of the code can be lost), versions 1 to 10: up to 213
// bytes, far more than a join link. The structure follows Project
// Nayuki's reference encoder (MIT): function patterns, Reed-Solomon
// over GF(256), interleaved blocks, the zigzag placement, and the
// mask with the lowest penalty. test/qr.test.mjs reads a code back.

// Error correction level M, by version (index 0 is unused).
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0;
export const MAX_VERSION = 10;

const bit = (x, i) => ((x >>> i) & 1) !== 0;

// Modules that carry data, function patterns aside.
export const rawModules = (ver) => {
  let n = (16 * ver + 128) * ver + 64;

  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;

    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }

  return n;
};

export const dataCodewords = (ver) =>
  Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

export const alignmentPositions = (ver) => {
  if (ver === 1) return [];

  const size = ver * 4 + 17;
  const count = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];

  for (let pos = size - 7; result.length < count; pos -= step) {
    result.splice(1, 0, pos);
  }

  return result;
};

// --- Reed-Solomon over GF(2^8), modulus x^8 + x^4 + x^3 + x^2 + 1 ---

export const gfMultiply = (x, y) => {
  let z = 0;

  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }

  return z & 0xff;
};

const divisor = (degree) => {
  const result = new Array(degree).fill(0);
  let root = 1;

  result[degree - 1] = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }

  return result;
};

export const rsRemainder = (data, degree) => {
  const div = divisor(degree);
  const result = new Array(degree).fill(0);

  for (const b of data) {
    const factor = b ^ result.shift();

    result.push(0);
    div.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }

  return result;
};

// --- Data ---------------------------------------------------------

const countBits = (ver) => (ver <= 9 ? 8 : 16);

export const versionFor = (length) => {
  for (let ver = 1; ver <= MAX_VERSION; ver++) {
    if (4 + countBits(ver) + 8 * length <= dataCodewords(ver) * 8) return ver;
  }

  throw new Error(`Too long for a QR code here: ${length} bytes.`);
};

// The data codewords: mode, count, the bytes, the terminator and the
// padding.
export const encodeData = (bytes, ver) => {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push(bit(value, i) ? 1 : 0);
  };
  const capacity = dataCodewords(ver) * 8;

  put(0b0100, 4);
  put(bytes.length, countBits(ver));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);

  const out = [];

  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) {
    out.push(pad);
  }

  return out;
};

// The blocks, each with its error correction, interleaved.
export const withEcc = (data, ver) => {
  const blocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const all = [];

  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);

    k += dat.length;

    const ecc = rsRemainder(dat, eccLen);

    if (i < shortBlocks) dat.push(0);
    all.push([...dat, ...ecc]);
  }

  const result = [];

  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) result.push(block[i]);
    });
  }

  return result;
};

// --- The matrix ---------------------------------------------------

export const formatBits = (mask) => {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;

  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);

  return ((data << 10) | rem) ^ 0x5412;
};

export const versionBits = (ver) => {
  let rem = ver;

  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);

  return (ver << 12) | rem;
};

export const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const grid = (size, value) =>
  Array.from({ length: size }, () => new Array(size).fill(value));

const blank = (ver) => {
  const size = ver * 4 + 17;
  const m = { ver, size, dark: grid(size, false), fixed: grid(size, false) };
  const set = (x, y, dark) => {
    m.dark[y][x] = dark;
    m.fixed[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;

        if (x >= 0 && x < size && y >= 0 && y < size) {
          set(x, y, d !== 2 && d !== 4);
        }
      }
    }
  };

  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  const align = alignmentPositions(ver);
  const last = align.length - 1;

  align.forEach((ay, i) => {
    align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last)
        || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });

  m.set = set;
  drawFormat(m, 0);

  if (ver >= 7) {
    const bits = versionBits(ver);

    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);

      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }

  return m;
};

// The format bits, both copies, and the dark module.
const drawFormat = (m, mask) => {
  const bits = formatBits(mask);
  const { set, size } = m;

  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true);
};

// The data modules in placement order: two columns at a time from the
// right, up then down, skipping the vertical timing column.
export const dataPath = (m) => {
  const path = [];

  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;

        if (!m.fixed[y][x]) path.push([x, y]);
      }
    }
  }

  return path;
};

const masked = (m, mask) => {
  const dark = m.dark.map((row, y) => row.map((d, x) =>
    (m.fixed[y][x] ? d : d !== MASKS[mask](x, y))));
  const out = { ...m, dark, fixed: m.fixed };

  out.set = (x, y, d) => {
    out.dark[y][x] = d;
  };
  drawFormat(out, mask);

  return out;
};

// The standard penalty: runs, 2x2 blocks, finder-like patterns and
// the balance of dark and light.
export const penalty = (dark) => {
  const size = dark.length;
  const lines = [
    ...dark,
    ...dark[0].map((_, x) => dark.map((row) => row[x])),
  ];
  const FINDER = [
    "10111010000", "00001011101",
  ];
  let score = 0;

  for (const line of lines) {
    let run = 1;

    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }

    const text = line.map((d) => (d ? "1" : "0")).join("");

    for (const f of FINDER) {
      for (let at = text.indexOf(f); at !== -1; at = text.indexOf(f, at + 1)) {
        score += 40;
      }
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = dark[y][x];

      if (c === dark[y][x + 1] && c === dark[y + 1][x]
        && c === dark[y + 1][x + 1]) score += 3;
    }
  }

  const total = size * size;
  const darkCount = dark.flat().filter(Boolean).length;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;

  return score + Math.max(0, k) * 10;
};

// The code for a text: { ver, size, mask, dark } where dark[y][x] is
// true for a dark module. `mask` forces one, for the tests.
export const encode = (text, { mask = null } = {}) => {
  const bytes = [...new TextEncoder().encode(String(text))];
  const ver = versionFor(bytes.length);
  const codewords = withEcc(encodeData(bytes, ver), ver);
  const base = blank(ver);

  dataPath(base).forEach(([x, y], i) => {
    base.dark[y][x] = i < codewords.length * 8
      && bit(codewords[i >>> 3], 7 - (i & 7));
  });

  const tries = mask === null ? MASKS.map((_, i) => i) : [mask];
  let best = null;

  for (const k of tries) {
    const m = masked(base, k);
    const score = penalty(m.dark);

    if (!best || score < best.score) best = { m, score, mask: k };
  }

  return {
    ver, size: base.size, mask: best.mask, dark: best.m.dark,
    fixed: base.fixed,
  };
};

// The code as an SVG: one path, dark on white, with the four-module
// quiet zone a scanner needs.
export const qrSvg = (text, { scale = 8, quiet = 4, title = "" } = {}) => {
  const { size, dark } = encode(text);
  const side = (size + quiet * 2) * scale;
  const runs = [];

  dark.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;

      let w = 1;

      while (x + w < size && row[x + w]) w += 1;
      runs.push(`M${(x + quiet) * scale} ${(y + quiet) * scale}h${
        w * scale}v${scale}h-${w * scale}z`);
      x += w - 1;
    }
  });

  const name = String(title).replace(/[<>&"]/g, "");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${
    side}" width="${side}" height="${side}" shape-rendering="crispEdges"${
    name ? ` role="img" aria-label="${name}"` : ""}>${
    name ? `<title>${name}</title>` : ""}<rect width="${side}" height="${
    side}" fill="#fff"/><path fill="#000" d="${runs.join("")}"/></svg>`;
};
