const Autoprefixer = require("autoprefixer");
const PurgeCSS = require("@fullhuman/postcss-purgecss");
const hoverOnly = require("./bin/postcss/hover-only.js");

const plugins = [
  hoverOnly(),
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
        // An out-of-stock row's label in the Add button's place (#303).
        "data-restock",
        "data-urgency",
        "soon",
        "last",
        "data-on",
        "data-open",
        // The account page's save line (#238).
        "data-save",
        "saving",
        "saved",
        "failed",
        // The header's link to the page you are on.
        "aria-current",
        "page",
        // The order cart's folds and its shared row (#203).
        "data-items",
        "data-money",
        "closed",
        "data-share",
        "way",
        "code",
        "readonly",
        "data-pay-state",
        "loading",
        "ready",
        "venmo-only",
        "unavailable",
        "good",
        "warn",
        "data-shown",
        "data-stuck",
        "data-scroll",
        "data-plain",
        "data-multi",
        "data-tight",
        // The sticky bar names a category; the cart is empty (#274).
        "data-cat",
        "data-empty",
        "data-pulse",
        // The Hide/Show pill's two pulses (#278).
        "teach",
        "once",
        "data-show",
        "data-more",
        "data-top",
        "data-card-open",
        "data-cart-passed",
        "data-busy",
        "data-row-start",
        "data-playing",
        "data-idle",
        "data-reveal",
        "role",
        "option",
        "aria-selected",
        "data-search-qty-state",
        "data-search-cart",
        "full",
        "aria-pressed",
        "data-layer",
        // The map's list row and pin lit by each other (#214).
        "data-hot",
        "delivery",
        "places",
        // A region loading (#271), set by scripts/utils/skeleton.js.
        "data-load",
        "wait",
        "shown",
        "aria-busy",
        // Added to the built HTML after Hugo, by bin/orphans/wrap.mjs
        // (#303), so Hugo's stats may never see it.
        "text-nowrap",
      ];
    },
    safelist: {
      standard: [
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
        "is-entering",
        "is-fading",
        "is-new",
        "is-ringed",
        "is-ticked",
        // Square's card form adds it once the SDK renders (#388).
        "sq-card-message",
        // The account page marks the order an email linked to.
        "is-linked",
        // The search palette's JavaScript: open, and a real photo.
        "is-open",
        "is-photo",
        // Its result rows, built by the script (#267).
        "search-palette-row-name",
        "search-palette-row-price",
        // Applied by session.js: the header's account slot fades in.
        "is-ready",
        "order-busy",
        "order-cart-free",
        "order-cart-group",
        "order-cart-group-name",
        "order-cart-group-items",
        "order-cart-item",
        "order-cart-item-name",
        "order-cart-item-qty",
        "order-cart-item-sub",
        "order-cart-remove",
        "order-cart-toggle-word",
        "order-chicks",
        "order-qty-tick",
        "form-control-plaintext",
        "text-danger-emphasis",
        // The loading skeletons (#271), some cloned in by scripts.
        /^placeholder/,
        /^skeleton/,
      ],
      // Bootstrap builds the tooltip at runtime.
      deep: [/^tooltip/, /^bs-tooltip/],
    },
  }),
];

module.exports = {
  plugins: plugins,
};
