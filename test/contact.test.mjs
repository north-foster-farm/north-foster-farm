import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MESSAGE_PREFIX, handle, validate } from
  "../netlify/functions/contact.mjs";
import { orderKey } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { farmContactMessage } from "../netlify/functions/lib/templates.mjs";

const now = new Date("2026-10-06T13:00:00Z");
const env = {
  URL: "https://northfosterfarm.com", ADMIN_EMAILS: "farm@example.com",
};
const good = {
  name: "Pat Example", email: " Pat@Example.com ",
  message: "Do you have duck eggs?",
};

// Each test its own address, so the per-address limit is its own.
let n = 0;
const ip = () => `10.0.0.${(n += 1)}`;

const mailbox = ({ fail = false } = {}) => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      if (fail) throw new Error("Resend 500");
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

const req = (body, headers = {}) => new Request("https://x/api/contact", {
  method: "POST",
  headers: {
    "Content-Type": "application/json", "sec-fetch-site": "same-origin",
    ...headers,
  },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const messages = async (stores) => Promise.all(
  (await stores.customers.list(MESSAGE_PREFIX))
    .map(({ key }) => stores.customers.get(key))
);

describe("validate", () => {
  it("names each missing field in the page's words", () => {
    const r = validate({ email: "nope" });

    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r.errors).sort(),
      ["email", "message", "name"]);
    assert.match(r.errors.email, /valid email/);
    assert.match(validate({}).errors.email, /so we can answer/);
  });

  it("trims, lowercases the email and tidies the order number", () => {
    const r = validate({ ...good, orderId: " #nff-2610-k3wm " });

    assert.equal(r.ok, true);
    assert.equal(r.message.email, "pat@example.com");
    assert.equal(r.message.orderId, "NFF-2610-K3WM");
  });
});

describe("POST /api/contact", () => {
  it("keeps the message and mails the farm with reply-to", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const res = await handle(req(good), {
      stores, env, now, ip: ip(), mail,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const [saved] = await messages(stores);

    assert.equal(saved.status, "open");
    assert.equal(saved.email, "pat@example.com");
    assert.equal(saved.order, null);
    assert.equal(saved.at, now.toISOString());
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["farm@example.com"]);
    assert.equal(sent[0].replyTo, "pat@example.com");
    assert.match(sent[0].subject, /^Message from Pat Example$/);
    assert.match(sent[0].text, /duck eggs/);
  });

  it("answers 422 with errors keyed by field, and keeps nothing",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const res = await handle(req({ name: "Pat" }), {
        stores, env, now, ip: ip(), mail,
      });

      assert.equal(res.status, 422);
      assert.deepEqual(Object.keys((await res.json()).errors).sort(),
        ["email", "message"]);
      assert.equal((await messages(stores)).length, 0);
      assert.equal(sent.length, 0);
    });

  it("tells the farm, and only the farm, whose order it is", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await stores.orders.set(orderKey("NFF-2610-AAAA"), {
      id: "NFF-2610-AAAA", customer: { email: "pat@example.com" },
    });
    await stores.orders.set(orderKey("NFF-2610-BBBB"), {
      id: "NFF-2610-BBBB", customer: { email: "sam@example.com" },
    });

    for (const orderId of ["nff-2610-aaaa", "NFF-2610-BBBB", "NFF-0000"]) {
      const res = await handle(req({ ...good, orderId }), {
        stores, env, now, ip: ip(), mail,
      });

      assert.deepEqual(await res.json(), { ok: true },
        "the writer learns nothing about the order");
    }

    assert.match(sent[0].text, /NFF-2610-AAAA, placed with this email/);
    assert.match(sent[0].html, /orders\/NFF-2610-AAAA/);
    assert.match(sent[1].text, /BBBB: no order by that number/);
    assert.doesNotMatch(sent[1].html, /View order/);
    assert.match(sent[2].text, /NFF-0000: no order by that number/);
    assert.deepEqual((await messages(stores)).map((m) => m.order).sort(),
      [false, false, true]);
  });

  it("drops the honeypot and a flood from one address quietly",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailbox();
      const bot = await handle(req({ ...good, website: "http://spam" }), {
        stores, env, now, ip: ip(), mail,
      });

      assert.equal(bot.status, 200);
      assert.equal(sent.length, 0);

      const one = ip();
      const statuses = [];

      for (let i = 0; i < 7; i += 1) {
        statuses.push((await handle(req(good), {
          stores, env, now, ip: one, mail,
        })).status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200]);
      assert.equal(sent.length, 5, "five in ten minutes, then silence");
      assert.equal((await messages(stores)).length, 5);
    });

  it("refuses a cross-site post and a body that is not JSON", async () => {
    const opts = { stores: testStores(), env, now, ip: ip(),
      mail: mailbox().mail };

    assert.equal((await handle(req(good, { "sec-fetch-site": "cross-site" }),
      opts)).status, 403);
    assert.equal((await handle(req("nope"), opts)).status, 400);
  });

  it("answers 500 when the mail fails, keeping the message", async () => {
    const stores = testStores();
    const { mail } = mailbox({ fail: true });
    const res = await handle(req(good), {
      stores, env, now, ip: ip(), mail,
    });

    assert.equal(res.status, 500);

    const [saved] = await messages(stores);

    assert.equal(saved.mailed, false);
    assert.equal(saved.status, "open");
  });

  it("keeps the message when no farm address is set", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const res = await handle(req(good), {
      stores, env: { URL: env.URL }, now, ip: ip(), mail,
    });

    assert.equal(res.status, 200);
    assert.equal(sent.length, 0);
    assert.equal((await messages(stores)).length, 1);
  });
});

describe("farmContactMessage", () => {
  it("escapes what the writer typed", () => {
    const m = farmContactMessage({
      name: "Pat", email: "pat@example.com", orderId: "",
      message: "<script>x</script> & more",
    });

    assert.match(m.html, /&lt;script&gt;x&lt;\/script&gt; &amp; more/);
    assert.doesNotMatch(m.html, /<script>/);
    assert.match(m.text, /<script>x<\/script> & more/);
  });
});
