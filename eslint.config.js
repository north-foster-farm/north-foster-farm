const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    "languageOptions": {
      "ecmaVersion": "latest",
      "globals": {
        ...globals.browser,
        ...globals.node,
      },
      "parserOptions": {
        "ecmaVersion": "latest",
        "ecmaFeatures": {
          "impliedStrict": true,
        },
      },
    },
    "rules": {
      "array-bracket-spacing": "error",
      "camelcase": "error",
      "capitalized-comments": [
        "error",
        "always",
        {
          "ignoreInlineComments": true,
          "ignoreConsecutiveComments": true,
        },
      ],
      "comma-dangle": [
        "error",
        {
          "arrays": "always-multiline",
          "objects": "always-multiline",
          "imports": "always-multiline",
          "exports": "always-multiline",
          "functions": "ignore",
        },
      ],
      "indent": ["warn", 2],
      "max-len": [
        "error",
        {
          "code": 80,
          "tabWidth": 2,
          "ignoreUrls": true,
        },
      ],
      // "no-console": [
      //   "error",
      //   {
      //     "allow": ["info", "warn", "error"],
      //   },
      // ],
      "no-constructor-return": "error",
      "no-else-return": "error",
      "no-multi-spaces": [
        "error",
        {
          "ignoreEOLComments": true,
        },
      ],
      "no-multiple-empty-lines": "error",
      "no-tabs": "error",
      "no-trailing-spaces": "error",
      "no-var": "error",
      "prefer-arrow-callback": "error",
      "prefer-const": "error",
      "prefer-template": "error",
      "quotes": [
        "error",
        "double",
        {
          "avoidEscape": true,
          "allowTemplateLiterals": true,
        },
      ],
      "semi": ["error", "always"],
      "space-in-parens": "error",
      "spaced-comment": "error",
    },
  },
  {
    // Square's, PayPal's and Netlify's request and response bodies are
    // snake_case.
    "files": [
      "netlify/functions/lib/square.mjs", "test/square.test.mjs",
      "netlify/functions/lib/paypal.mjs", "test/paypal.test.mjs",
      "netlify/functions/paypal-webhook.mjs", "test/checkout.test.mjs",
      "test/payments.test.mjs", "test/fake.test.mjs", "test/webhooks.test.mjs",
      "test/sourcemaps.test.mjs", "test/groups.test.mjs",
      "test/group-credit.test.mjs", "test/square-fixtures.test.mjs",
      "test/fixtures-record.test.mjs",
      "test/square-replay.test.mjs", "test/fake-square.test.mjs",
      "test/mail-replay.test.mjs",
      "netlify/functions/lib/fake-square.mjs",
    ],
    "rules": {
      "camelcase": ["error", { "properties": "never" }],
    },
  },
  {
    // The CLIs have no extension; they are ES modules all the same.
    "files": ["bin/nff", "bin/gh-shot", "bin/fixtures/scrub"],
    "languageOptions": {
      "sourceType": "module",
    },
  },
];
