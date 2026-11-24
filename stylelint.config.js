module.exports = {
  "extends": "stylelint-config-standard-scss",
  // `npm run lint` reads every stylesheet in the tree (#769); these
  // folders are build output or untracked notes, never source.
  "ignoreFiles": [
    ".ignored/**",
    ".netlify/**",
    "docs/example-projects/**",
    "docs/hugo-docs-source/**",
    "playwright-report/**",
    "public/**",
    "resources/**",
    "test-results/**",
  ],
  // A disable that suppresses nothing, or names a rule that is not on,
  // is an error (#782).
  "reportNeedlessDisables": true,
  "reportInvalidScopeDisables": true,
  "plugins": [
    "stylelint-scss",
  ],
  "rules": {
    "at-rule-no-unknown": [
      true,
      {
        "ignoreAtRules": [
          "at-root",
          "content",
          "debug",
          "each",
          "else",
          "error",
          "extend",
          "for",
          "forward",
          "function",
          "if",
          "include",
          "mixin",
          "return",
          "use",
          "warn",
          "while",
        ],
      },
    ],
    // Range syntax (width >= 768px) is unsupported in Safari before
    // 16.4, so the classic prefixes stay.
    "media-feature-range-notation": "prefix",
    "no-empty-source": null,
    "scss/at-extend-no-missing-placeholder": null,
  },
};
