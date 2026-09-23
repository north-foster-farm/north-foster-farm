import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle, validate } from "../netlify/functions/contact.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const env = { ADMIN_EMAILS: "farm@x.com", URL: "https://x" };

const mailbox = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

const post = (body, headers = {}) => new Request("https://x/api/contact", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "sec-fetch-site": "same-origin",
    ...headers,
  },
  body: JSON.stringify(body),
});

const good = {
  name: " Pat Example ", email: "Pat@Example.com", orderId: "nff-2610-k3wm",
  message: "Can I add a dozen eggs to my order?\n\nThanks!",
};

describe("the contact form", () => {
  it("wants a name, an answerable email and a message", () => {
    const ok = validate(good);

    assert.equal(ok.ok, true);
    assert.deepEqual(ok.message, {
      name: "Pat Example", email: "pat@example.com", orderId: "NFF-2610-K3WM",
      message: "Can I add a dozen eggs to my order?\n\nThanks!",
    });

    const bad = validate({
      name: "", email: "nope", orderId: "x!", message: "",
    });

    assert.equal(bad.ok, false);
    assert.deepEqual(Object.keys(bad.errors).sort(),
      ["email", "message", "name", "orderId"]);
    assert.equal(validate({ ...good, orderId: "" }).ok, true);
  });

  it("mails the farm with reply-to set to the writer", async () => {
    const { sent, mail } = mailbox();
    const res = await handle(post(good), {
      stores: testStores(), env, now, mail, ip: "1.1.1.1",
    });

    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["farm@x.com"]);
    assert.equal(sent[0].replyTo, "pat@example.com");
    assert.equal(sent[0].subject,
      "Message from Pat Example about NFF-2610-K3WM");
    assert.match(sent[0].text, /Pat Example wrote from the contact page/);
    assert.match(sent[0].text, /- pat@example.com\n- Order NFF-2610-K3WM/);
    assert.match(sent[0].text,
      /\nCan I add a dozen eggs to my order\?\n\nThanks!\n/);
    assert.match(sent[0].html, /<blockquote [^>]*>Can I add a dozen eggs/);
    assert.match(sent[0].text, new RegExp("View order: https://admin\\." +
      "northfosterfarm\\.com/orders/NFF-2610-K3WM"));
  });

  it("answers 422 with field errors, and 403 to another site", async () => {
    const { sent, mail } = mailbox();
    const res = await handle(post({ name: "Pat" }), {
      stores: testStores(), env, now, mail,
    });

    assert.equal(res.status, 422);
    assert.deepEqual(Object.keys((await res.json()).errors).sort(),
      ["email", "message"]);
    assert.equal(sent.length, 0);

    const cross = await handle(post(good, { "sec-fetch-site": "cross-site" }),
      { stores: testStores(), env, now, mail });

    assert.equal(cross.status, 403);
  });

  it("swallows the honeypot and a chatty address without a word",
    async () => {
      const { sent, mail } = mailbox();
      const stores = testStores();
      const bot = await handle(post({ ...good, website: "http://spam" }), {
        stores, env, now, mail,
      });

      assert.equal(bot.status, 200);
      assert.equal(sent.length, 0);

      for (let i = 0; i < 7; i += 1) {
        await handle(post(good), { stores, env, now, mail, ip: "9.9.9.9" });
      }
      assert.equal(sent.length, 5, "five in ten minutes, then silence");
    });

  it("still answers 200 when nobody at the farm is listed", async () => {
    const { sent, mail } = mailbox();
    const res = await handle(post(good), {
      stores: testStores(), env: {}, now, mail,
    });

    assert.equal(res.status, 200);
    assert.equal(sent.length, 0);
  });
});
