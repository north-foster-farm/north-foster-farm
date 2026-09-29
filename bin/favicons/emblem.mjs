// The gingham egg, the site's favicon, as SVG at any size. Called by
// bin/favicons/build:
//
//   node bin/favicons/emblem.mjs color <size> [square]
//   node bin/favicons/emblem.mjs mono
//
// At 512 and the other large sizes it is the master design: a brown
// egg in a white ring on green gingham of nine even bands, dark at
// both edges, in a rounded tile ("square" drops the rounding, for the
// icons iOS and Android shape themselves). At 16, 32 and 48 px it is
// snapped to the pixel grid: eight bands of whole pixels, the two
// middle ones merged under the egg so the pattern stays symmetric,
// and the egg and its ring set to whole-pixel heights. "mono" is the
// one-color silhouette for Safari's pinned tabs.
//
// The egg is a true egg curve, x = w sin t (1 - e cos t),
// y = -h cos t, sampled at 32 points and joined with Catmull-Rom
// cubics; that stays within 0.03 units of the curve on the 512 grid.

const BASE = "#e3f1e8";
const STRIPE = "#77b097";
const CROSS = "#469372";
const RING = "#ffffff";
const EGG = "#c47a45";
const TAPER = 0.16;

// The master design, as fractions of the tile.
const HEIGHT = 320 / 512;
const RATIO = 0.7;
const RING_WIDTH = 26 / 512;
const RADIUS = 112 / 512;

// Pixel-snapped eggs: brown top, brown bottom, width and ring, in px.
const SNAPPED = {
  16: { top: 3, bottom: 13, width: 7, ring: 1 },
  32: { top: 6, bottom: 26, width: 14, ring: 2 },
  48: { top: 9, bottom: 39, width: 22, ring: 3 },
};

const fmt = (v) => String(Number(v.toFixed(3)));

const widest = Math.max(...Array.from({ length: 2001 }, (_, i) => {
  const t = (i * Math.PI) / 2000;

  return Math.sin(t) * (1 - TAPER * Math.cos(t));
}));

const eggPoints = (cx, cy, height, width, n = 32) => {
  const h = height / 2;
  const w = width / 2 / widest;

  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;

    return [cx + w * Math.sin(t) * (1 - TAPER * Math.cos(t)),
      cy - h * Math.cos(t)];
  });
};

// A closed Catmull-Rom spline through the points, as cubic Beziers.
const smoothPath = (pts) => {
  const n = pts.length;
  const at = (i) => pts[(i + n) % n];
  const d = [`M${fmt(pts[0][0])} ${fmt(pts[0][1])}`];

  for (let i = 0; i < n; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];

    d.push(`C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ` +
      `${fmt(p2[0])} ${fmt(p2[1])}`);
  }

  return `${d.join("")}Z`;
};

// The dark bands, [start, width], the same on both axes.
const bands = (size, snapped) => {
  const b = snapped ? size / 8 : size / 9;
  const dark = snapped ? [0, 2, 5, 7] : [0, 2, 4, 6, 8];

  return dark.map((i) => [i * b, b]);
};

const gingham = (size, snapped) => {
  const dark = bands(size, snapped);
  const out = [`<rect width="${size}" height="${size}" fill="${BASE}"/>`];

  for (const [x, w] of dark) {
    out.push(`<rect x="${fmt(x)}" width="${fmt(w)}" height="${size}" ` +
      `fill="${STRIPE}"/>`);
    out.push(`<rect y="${fmt(x)}" width="${size}" height="${fmt(w)}" ` +
      `fill="${STRIPE}"/>`);
  }
  for (const [x, w] of dark) {
    for (const [y, h] of dark) {
      out.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" ` +
        `height="${fmt(h)}" fill="${CROSS}"/>`);
    }
  }

  return out.join("");
};

export const color = (size, { square = false } = {}) => {
  const snap = SNAPPED[size];
  const c = size / 2;
  const height = snap ? snap.bottom - snap.top : HEIGHT * size;
  const width = snap ? snap.width : RATIO * height;
  const ring = snap ? snap.ring : RING_WIDTH * size;
  const cy = snap ? (snap.top + snap.bottom) / 2 : c;
  const egg = smoothPath(eggPoints(c, cy, height, width));
  const radius = square ? "0" : fmt(RADIUS * size);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ` +
    `${size}" width="${size}" height="${size}">` +
    "<title>North Foster Farm</title>" +
    `<defs><clipPath id="tile"><rect width="${size}" height="${size}" ` +
    `rx="${radius}"/></clipPath></defs>` +
    `<g clip-path="url(#tile)">${gingham(size, Boolean(snap))}</g>` +
    `<path fill="${RING}" stroke="${RING}" stroke-width="${fmt(ring * 2)}" ` +
    `stroke-linejoin="round" d="${egg}"/>` +
    `<path fill="${EGG}" d="${egg}"/></svg>\n`;
};

// The tile, the egg's ring cut out of it, and the egg inside. The
// gingham is left out: in one color at tab size it is only noise. The
// ring is drawn wider than in color, so the gap survives at 16 px.
export const mono = (size = 512) => {
  const height = HEIGHT * size;
  const egg = smoothPath(eggPoints(size / 2, size / 2, height,
    RATIO * height));
  const ring = RING_WIDTH * size * 1.6;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ` +
    `${size}"><defs><mask id="ring"><rect width="${size}" ` +
    `height="${size}" fill="#fff"/><path fill="#000" stroke="#000" ` +
    `stroke-width="${fmt(ring * 2)}" stroke-linejoin="round" ` +
    `d="${egg}"/></mask></defs>` +
    `<rect width="${size}" height="${size}" rx="${fmt(RADIUS * size)}" ` +
    `mask="url(#ring)"/><path d="${egg}"/></svg>\n`;
};

const [kind, size, shape] = process.argv.slice(2);

if (kind === "color") {
  process.stdout.write(color(Number(size), { square: shape === "square" }));
} else if (kind === "mono") {
  process.stdout.write(mono());
} else if (kind) {
  process.stderr.write(`emblem: unknown kind "${kind}"\n`);
  process.exit(1);
}
