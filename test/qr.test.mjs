// The QR encoder for a group's join link (#495): held to the
// standard's published values (the format strings, the version
// string, the alignment table, the Reed-Solomon example), then read
// back from the matrix as a scanner would and compared with the text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MASKS, alignmentPositions, dataCodewords, dataPath, encode, formatBits,
  qrSvg, rsRemainder, versionBits, versionFor,
} from "../netlify/functions/lib/qr.mjs";

// Level M's format strings, masks 0 to 7, most significant bit first.
const FORMAT_M = [
  "101010000010010", "101000100100101", "101111001111100",
  "101101101001011", "100010111111001", "100000011001110",
  "100111110010111", "100101010100000",
];

const LINK = "https://www.northfosterfarm.com/join/?t=" +
  "q3Jm0f9xR2kVtZ8pLwE4sNbY7cH1dAoUeGiK6uXyTzW";

// The first copy of the format bits, as a scanner reads it.
const readFormat = (dark) => {
  const at = [
    ...[0, 1, 2, 3, 4, 5].map((i) => [8, i]), [8, 7], [8, 8], [7, 8],
    ...[9, 10, 11, 12, 13, 14].map((i) => [14 - i, 8]),
  ];

  return at.reduce((bits, [x, y], i) => bits | ((dark[y][x] ? 1 : 0) << i), 0);
};

// Level M's blocks by version, as the standard tabulates them:
// [error correction per block, short blocks, their data, long blocks].
const BLOCKS = { 1: [10, 1, 16, 0], 5: [24, 2, 43, 0], 10: [26, 4, 43, 1] };

// The text back out of the matrix: unmask, follow the placement, take
// the blocks apart, check each one's error correction, read the bytes.
const decode = (code) => {
  const { dark, mask } = code;
  const path = dataPath(code);
  const bits = path.map(([x, y]) => dark[y][x] !== MASKS[mask](x, y));
  const words = [];

  for (let i = 0; i + 8 <= bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | +b, 0));
  }

  const [ecc, shortCount, shortData, longCount] = BLOCKS[code.ver];
  const count = shortCount + longCount;
  const blocks = Array.from({ length: count }, (_, j) => ({
    data: [], ecc: [], len: shortData + (j < shortCount ? 0 : 1),
  }));
  let k = 0;

  for (let i = 0; i < shortData + 1; i++) {
    for (const b of blocks) if (i < b.len) b.data.push(words[k++]);
  }
  for (let i = 0; i < ecc; i++) for (const b of blocks) b.ecc.push(words[k++]);
  for (const b of blocks) assert.deepEqual(rsRemainder(b.data, ecc), b.ecc);

  const data = blocks.flatMap((b) => b.data);
  const stream = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0]
    .map((i) => (w >>> i) & 1));
  const read = (from, n) => stream.slice(from, from + n)
    .reduce((a, b) => (a << 1) | b, 0);

  assert.equal(read(0, 4), 0b0100, "byte mode");

  const countBits = code.ver <= 9 ? 8 : 16;
  const length = read(4, countBits);
  const bytes = Array.from({ length },
    (_, i) => read(4 + countBits + i * 8, 8));

  return new TextDecoder().decode(new Uint8Array(bytes));
};

describe("the QR encoder", () => {
  it("has level M's format strings", () => {
    FORMAT_M.forEach((s, mask) => {
      assert.equal(formatBits(mask).toString(2).padStart(15, "0"), s);
    });
  });

  it("has version 7's version string", () => {
    assert.equal(versionBits(7), 0x07c94);
  });

  it("places the alignment patterns where the table says", () => {
    assert.deepEqual(alignmentPositions(1), []);
    assert.deepEqual(alignmentPositions(2), [6, 18]);
    assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
    assert.deepEqual(alignmentPositions(10), [6, 28, 50]);
  });

  it("holds level M's data capacity", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 10].map(dataCodewords),
      [16, 28, 44, 64, 86, 216]);
    assert.equal(versionFor(14), 1);
    assert.equal(versionFor(15), 2);
    assert.equal(versionFor(84), 5);
    assert.equal(versionFor(85), 6);
    assert.throws(() => versionFor(214), /Too long/);
  });

  it("works the standard's Reed-Solomon example (HELLO WORLD, 1-M)",
    () => {
      const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17,
        236, 17, 236, 17];

      assert.deepEqual(rsRemainder(data, 10),
        [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    });

  it("reads back as the join link, in every mask", () => {
    for (let mask = 0; mask < 8; mask++) {
      const code = encode(LINK, { mask });

      assert.equal(code.ver, 5);
      assert.equal(readFormat(code.dark), formatBits(mask));
      assert.equal(decode(code), LINK);
    }
  });

  it("reads back at the smallest and the largest version", () => {
    assert.equal(decode(encode("NFF")), "NFF");
    assert.equal(encode("NFF").ver, 1);

    // 194 bytes: past version 9's 180, so version 10's five blocks.
    const long = `${LINK}&${"x".repeat(110)}`;

    assert.equal(encode(long).ver, 10);
    assert.equal(decode(encode(long)), long);
  });

  it("has its finders and timing where a scanner looks", () => {
    const { dark, size } = encode(LINK);
    const ring = (cx, cy) => [-3, -2, -1, 0, 1, 2, 3]
      .map((d) => dark[cy - 3][cx + d]);

    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      assert.deepEqual(ring(cx, cy), [true, true, true, true, true, true,
        true]);
      assert.equal(dark[cy][cx], true);
    }
    for (let i = 8; i < size - 8; i++) {
      assert.equal(dark[6][i], i % 2 === 0);
      assert.equal(dark[i][6], i % 2 === 0);
    }
    assert.equal(dark[size - 8][8], true, "the dark module");
  });

  it("draws an SVG with a quiet zone and an escaped title", () => {
    const svg = qrSvg(LINK, { scale: 4, title: "Join <the> group" });
    const side = (37 + 8) * 4;

    assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
    assert.match(svg, /<title>Join the group<\/title>/);
    assert.ok(!svg.includes("<the>"));
  });
});
