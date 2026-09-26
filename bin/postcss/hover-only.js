// Hover styles only where something can hover. A phone keeps :hover
// on the last element tapped until a tap lands elsewhere, so a tapped
// button stays shaded and lifted as if the finger never left. This
// moves every selector that tests :hover, Bootstrap's included, into
// @media (hover: hover), right where it was, so the cascade keeps its
// order. The rest of a selector list stays outside, so a
// `:hover, :focus-visible` rule still shows the keyboard its focus.

const HOVER = /:hover(?![\w-])/;
const MEDIA = "(hover: hover)";

const inHoverMedia = (node) => {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === "atrule" && at.name === "media" &&
      at.params.includes("hover: hover")) return true;
  }

  return false;
};

const hoverOnly = () => ({
  postcssPlugin: "hover-only",
  Once(root, { AtRule }) {
    root.walkRules((rule) => {
      if (!HOVER.test(rule.selector) || inHoverMedia(rule)) return;
      if (rule.parent.type === "atrule" &&
        rule.parent.name.endsWith("keyframes")) return;

      const hover = rule.selectors.filter((s) => HOVER.test(s));
      const rest = rule.selectors.filter((s) => !HOVER.test(s));
      const media = new AtRule({ name: "media", params: MEDIA });

      if (rest.length) {
        media.append(rule.clone({ selectors: hover }));
        rule.selectors = rest;
        rule.after(media);
      } else {
        rule.replaceWith(media);
        media.append(rule);
      }
    });
  },
});

hoverOnly.postcss = true;

module.exports = hoverOnly;
