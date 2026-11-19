// Square's version conflict as the sandbox gave it (#658): the 400
// that a PUT on /v2/orders/{id} gets when it carries a stale `version`.
// `bin/fixtures/record` makes it by cancelling a sandbox order's
// fulfillment and then sending the same PUT again, at the version the
// cancel has just moved past. Every #658 test takes its conflict from
// here and never writes one by hand; test/version-conflict-658.test.mjs
// holds the fixture to that.

import { failure } from "../netlify/functions/lib/square.mjs";
import { recorded } from "./recorded.mjs";

export const CONFLICT = "order-update-stale-version";

// The whole recording: { _source, status, request, response }.
export const conflict = () => recorded("square", CONFLICT);

// Square's code for it, read from the recording.
export const conflictCode = () => conflict().response.errors[0].code;

// Any recorded refusal as lib/square.mjs raises it: a SquareError with
// Square's status and code (`failure`, the same function `call` uses).
export const refusal = (name, path) => {
  const { status, response, request } = recorded("square", name);

  return failure(status, response, path || request.path);
};
