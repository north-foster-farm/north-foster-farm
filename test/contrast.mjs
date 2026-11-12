// WCAG 2's contrast ratio between two sRGB colours (#560): 3:1 is the
// floor for a control's graphic (1.4.11), 4.5:1 for body text. Takes
// "#rgb", "#rrggbb" or a computed "rgb(r, g, b)"; alpha is not
// handled, so pass solid colours. Used by test/remove-icon.test.mjs and
// e2e/remove-icon.spec.mjs.

const channels = (colour) => {
  const hex = colour.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);

  if (hex) {
    const h = hex[1].length === 3
      ? [...hex[1]].map((c) => c + c).join("")
      : hex[1];

    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  const rgb = colour.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);

  if (rgb) return rgb.slice(1, 4).map(Number);
  throw new Error(`not a colour: ${colour}`);
};

const linear = (c) => {
  const s = c / 255;

  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminance = (colour) => {
  const [r, g, b] = channels(colour).map(linear);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi + 0.05) / (lo + 0.05);
};
