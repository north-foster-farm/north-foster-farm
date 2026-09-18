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
        // such as [hidden] and [type="radio"] need naming here, both
        // the attribute and the values the CSS tests.
        "hidden",
        "inert",
        "disabled",
        "open",
        "type",
        "radio",
        "checkbox",
        "value",
        "aria-expanded",
        "true",
        "false",
        "data-qty-state",
        "empty",
        "active",
        "data-pending-state",
        "sending",
        "waiting",
        "data-status",
        "submitted",
        "paid",
        "fulfilled",
        "cancelled",
        "abandoned",
        "data-tone",
        "ok",
        "wait",
        "no",
        "data-bs-popper",
        "static",
        "data-stock",
        "out",
        "low",
        "data-urgency",
        "soon",
        "last",
        "data-on",
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
      "showing",
      "hiding",
      "offcanvas-backdrop",
      "was-validated",
      // Applied by the order form's JavaScript, never in a template.
      "is-invalid",
      "is-valid",
      "is-active",
      "is-bumped",
      "order-busy",
      "order-cart-free",
      "order-feathers",
      "order-qty-tick",
      "text-danger-emphasis",
    ],
  }),
];

module.exports = {
  plugins: plugins,
};
