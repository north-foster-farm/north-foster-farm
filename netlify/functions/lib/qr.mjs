// A QR code for a buying group's join link (#495), drawn as SVG on the
// server so the host's download is the code in force. The matrix comes
// from qrcode-generator (MIT, pinned; James approved it on #471,
// comment 6455715360). This file only draws it, so the package stays
// behind the one function the callers use.
//
// Error correction level M: about 15% of the code can be lost to wear
// or dirt on a printed sign and it still scans. The version is the
// smallest that holds the text.

import qrcode from "qrcode-generator";

const LEVEL = "M";

// The package's byte mode reads each character as one byte, which is
// right for ASCII only. A join link is ASCII (the token is URL-safe and
// the site address has no other characters), so anything else is a bug
// upstream, not a code to print.
const matrix = (text) => {
  const s = String(text);

  if (/[^\x20-\x7e]/.test(s)) throw new Error("QR text must be ASCII");

  const qr = qrcode(0, LEVEL);

  qr.addData(s, "Byte");
  qr.make();

  return { qr, size: qr.getModuleCount() };
};

// The code as an SVG: one path, dark on white, with the four-module
// quiet zone a scanner needs.
export const qrSvg = (text, { scale = 8, quiet = 4, title = "" } = {}) => {
  const { qr, size } = matrix(text);
  const side = (size + quiet * 2) * scale;
  const runs = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.isDark(y, x)) continue;

      let w = 1;

      while (x + w < size && qr.isDark(y, x + w)) w += 1;
      runs.push(`M${(x + quiet) * scale} ${(y + quiet) * scale}h${
        w * scale}v${scale}h-${w * scale}z`);
      x += w - 1;
    }
  }

  // Escaped to entities, not deleted, so "Smith & Co" stays whole.
  const name = String(title).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;",
  })[c]);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${
    side}" width="${side}" height="${side}" shape-rendering="crispEdges"${
    name ? ` role="img" aria-label="${name}"` : ""}>${
    name ? `<title>${name}</title>` : ""}<rect width="${side}" height="${
    side}" fill="#fff"/><path fill="#000" d="${runs.join("")}"/></svg>`;
};
