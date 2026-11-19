// The implementer's own tests for #658's retry, beside the criteria
// tests in test/square-version-conflict.test.mjs: what a fresh read
// may find that the first did not. Every answer is a recording.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelFulfillment } from "../netlify/functions/lib/square.mjs";
import { body, recorded } from "./recorded.mjs";
import { conflict } from "./version-conflict.mjs";

const SANDBOX = {
  SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "tok",
  SQUARE_LOCATION_ID: "LOCATION_ID_1",
};
const ID = "ORDER_ID_5";
const ORDER = "order-get-paid-external";

// The recorded order, a version on, with its fulfillments changed.
const reread = (change) => {
  const answer = body("square", ORDER);

  answer.order.version += 1;
  answer.order.fulfillments = change(answer.order.fulfillments);

  return { status: 200, response: answer };
};

const inTurn = (...answers) => {
  const requests = [];
  const impl = async (url, init = {}) => {
    requests.push(init.method || "GET");

    const { status, response } = answers[requests.length - 1]
      || { status: 404, response: {} };

    return new Response(JSON.stringify(response), { status });
  };

  return { impl, requests };
};

const first = () => {
  const { status, response } = recorded("square", ORDER);

  return { status, response };
};
const sleep = async () => {};

describe("#658: the read after a version conflict", () => {
  it("stops when the fresh read finds the fulfillment cancelled",
    async () => {
      const net = inTurn(first(), conflict(), reread((fs) => fs.map((f) => ({
        ...f, state: "CANCELED",
      }))));
      const result = await cancelFulfillment(ID, {
        env: SANDBOX, fetchImpl: net.impl, sleep,
      });

      assert.deepEqual(result, { id: ID, cancelled: false });
      assert.deepEqual(net.requests, ["GET", "PUT", "GET"]);
    });

  it("throws, with no second PUT, when the fresh read has lost the " +
    "fulfillment the first read found", async () => {
    const net = inTurn(first(), conflict(), reread((fs) => fs.map((f) => ({
      ...f, uid: "ANOTHER_UID",
    }))));

    await assert.rejects(cancelFulfillment(ID, {
      env: SANDBOX, fetchImpl: net.impl, sleep,
    }), /lost its fulfillment/);
    assert.deepEqual(net.requests, ["GET", "PUT", "GET"]);
  });
});
