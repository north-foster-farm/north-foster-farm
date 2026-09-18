module.exports = {
  "extends": "stylelint-config-standard-scss",
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
