const Autoprefixer = require("autoprefixer");
const PurgeCSS = require("@fullhuman/postcss-purgecss");

const plugins = [
  new Autoprefixer(),
  new PurgeCSS({
    content: ["./hugo_stats.json"],
    defaultExtractor: (content) => {
      const elements = JSON.parse(content).htmlElements;

      return [
        ...(elements.tags || []),
        ...(elements.classes || []),
        ...(elements.ids || []),
        // Hugo's stats carry no attributes, so attribute selectors
        // such as [hidden] and [type="radio"] need naming here.
        "hidden",
        "disabled",
        "type",
        "radio",
        "checkbox",
      ];
    },
    safelist: [
      "active",
      "collapse",
      "collapse-horizontal",
      "collapsed",
      "collapsing",
      "fade",
      "show",
      "was-validated",
      // Applied by the order form's JavaScript, never in a template.
      "is-invalid",
      "is-valid",
      "order-busy",
    ],
  }),
];

module.exports = {
  plugins: plugins,
};
