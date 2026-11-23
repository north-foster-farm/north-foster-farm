const js = require("@eslint/js");
const globals = require("globals");

// The core rules beyond recommended that hold every script (#782, steps
// 1 and 2 of the proposal): the 17 that found nothing on the code and
// the nine small ones whose findings were fixed.
const correctness = [
  "array-callback-return",
  "consistent-return",
  "default-case-last",
  "eqeqeq",
  "guard-for-in",
  "no-alert",
  "no-duplicate-imports",
  "no-eval",
  "no-extend-native",
  "no-implied-eval",
  "no-inner-declarations",
  "no-loop-func",
  "no-new-func",
  "no-new-wrappers",
  "no-param-reassign",
  "no-promise-executor-return",
  "no-return-assign",
  "no-self-compare",
  "no-sequences",
  "no-throw-literal",
  "no-unmodified-loop-condition",
  "no-unreachable-loop",
  "no-unused-expressions",
  "no-useless-assignment",
  "prefer-promise-reject-errors",
  "radix",
];

module.exports = [
  // `npm run lint` reads the whole tree (#769); these folders are build
  // output, run output or untracked notes, never source.
  {
    "ignores": [
      ".ignored/",
      ".netlify/",
      "docs/example-projects/",
      "docs/hugo-docs-source/",
      "incidents/",
      "netlify/edge-functions/",
      "playwright-report/",
      "public/",
      "resources/",
      "test-results/",
    ],
  },
  js.configs.recommended,
  {
    "linterOptions": {
      "reportUnusedDisableDirectives": "error",
    },
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
      ...Object.fromEntries(correctness.map((rule) => [rule, "error"])),
    },
  },
  {
    // The vendors' request and response bodies are snake_case: Square's,
    // PayPal's, Netlify's, Resend's, GitHub's and npm's. Their names pass as
    // properties only (#791 c7105461370).
    "files": [
      "netlify/functions/lib/square.mjs", "test/square.test.mjs",
      "netlify/functions/lib/square-shapes.mjs",
      "netlify/functions/lib/paypal.mjs", "test/paypal.test.mjs",
      "netlify/functions/paypal-webhook.mjs", "test/checkout.test.mjs",
      "test/payments.test.mjs", "test/fake.test.mjs", "test/webhooks.test.mjs",
      "test/sourcemaps.test.mjs", "test/groups.test.mjs",
      "test/group-credit.test.mjs", "test/square-fixtures.test.mjs",
      "test/fixtures-record.test.mjs",
      "test/square-replay.test.mjs", "test/fake-square.test.mjs",
      "test/mail-replay.test.mjs",
      "netlify/functions/lib/fake-square.mjs",
      "bin/hotfix.mjs",
      "bin/redeploy.mjs",
      "netlify/functions/lib/news.mjs",
      "test/attempts.test.mjs",
      "test/audience-apply.test.mjs",
      "test/breaker.test.mjs",
      "test/codeql-gate.test.mjs",
      "test/drift.test.mjs",
      "test/e2e-dispatch-all-pages.test.mjs",
      "test/e2e-dispatch-pages.test.mjs",
      "test/e2e-dispatch.test.mjs",
      "test/e2e-help.test.mjs",
      "test/e2e-report-run.test.mjs",
      "test/e2e-retry-verdict.test.mjs",
      "test/e2e-verdict.test.mjs",
      "test/hotfix-helpers.test.mjs",
      "test/hotfix-world.mjs",
      "test/member-id.test.mjs",
      "test/merge.test.mjs",
      "test/news.test.mjs",
      "test/order-id-length.test.mjs",
      "test/perk-pricing.test.mjs",
      "test/promote-exempt-reading.test.mjs",
      "test/promote-exempt.test.mjs",
      "test/promote-override-guards.test.mjs",
      "test/promote-retry.test.mjs",
      "test/promote.test.mjs",
      "test/redeploy.test.mjs",
      "test/rename.test.mjs",
      "test/resend-fixture.mjs",
      "test/resend-webhook.test.mjs",
      "test/webhook-security.test.mjs",
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
