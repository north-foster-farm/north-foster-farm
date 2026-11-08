// The fake payment drivers (#265). SQUARE_ENV=fake and PAYPAL_ENV=fake
// answer every Square and PayPal call on this machine (fake-square.mjs,
// fake-paypal.mjs), and the order page loads stub SDKs from /scripts/
// (assets/scripts/fake/), so a fresh clone takes card and Venmo orders
// with no vendor account and nothing leaves the machine.
//
// Local development only: the deploy context must be "dev", which
// bin/nff sets and the development env file holds. Anywhere else
// (production, staging, a preview, or no context at all, which counts
// as production) the value is refused: every call throws and the page
// is offered no payment, so a stray `fake` can never quietly take
// orders without money.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { deployContext } from "./store.mjs";

export const FAKE = "fake";

export const FAKE_CONTEXT = "dev";

export const FAKE_SDK_URLS = {
  square: "/scripts/fake-square.js",
  paypal: "/scripts/fake-paypal.js",
};

// Twice over: the context, and the machine. A deployed function runs
// on AWS Lambda, which sets AWS_LAMBDA_FUNCTION_NAME; `netlify dev`
// sets NETLIFY_DEV (its lambda-local may set the Lambda name too), and
// bin/nff and the tests set neither. So a SITE_CONTEXT=dev slipped
// onto a deployed context still gets no fake.
export const onThisMachine = (env = process.env) =>
  !!env.NETLIFY_DEV || !env.AWS_LAMBDA_FUNCTION_NAME;

export const fakeAllowed = (env = process.env) =>
  deployContext(env) === FAKE_CONTEXT && onThisMachine(env);

export const refusal = (name) => `${name}=${FAKE} is for local ` +
  `development only (SITE_CONTEXT=${FAKE_CONTEXT}); refused here`;

// A stable id from what the real call's idempotency key is made of, so
// a retry gets the same fake object back, as it would from the vendor.
export const fakeId = (prefix, ...parts) => `${prefix}-${createHash("sha256")
  .update(parts.map(String).join("|")).digest("hex").slice(0, 16)
  .toUpperCase()}`;

// A vendor's recorded answer, for the fake to return in place of the
// vendor's (test/fixtures/README.md, bin/fixtures/record): { _source,
// status, request, response }. Read when asked for, so a deploy that
// never fakes never needs the files. A fresh copy each time.
export const recorded = (service, name) => {
  const file = new URL(
    `../../../test/fixtures/${service}/${name}.json`, import.meta.url
  );

  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`No recorded ${service} answer "${name}" (${
      error.code}); run bin/fixtures/record`, { cause: error });
  }
};
