import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Draft, forgetCustomer } from "../assets/scripts/order/draft.js";
import {
  cartOf, settle, signedOut, stray,
} from "../assets/scripts/order/lib/cart-sync.mjs";
import {
  SCRUBBED, pullCart, push, scrubStray,
} from "../assets/scripts/session/cart-sync.js";
import {
  cartOwner, getCart, saveCart,
} from "../netlify/functions/lib/account.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import {
  deleteCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/account.mjs";
import { handle as authHandle } from "../netlify/functions/auth.mjs";

const now = new Date("2026-10-05T13:00:00Z");
const T = now.getTime();
const pat = { email: "pat@example.com", name: "Pat Example" };

const payload = (lines = [{ sku: "A", qty: 2 }]) => ({
  formVersion: "3",
  customer: { firstName: "Pat", lastName: "Example",
    email: "pat@example.com", phone: "", contact: "text", marketing: false },
  lines,
  fulfilment: { method: "onfarm", date: "2026-10-07",
    onfarm: { window: "morning" }, delivery: {} },
  code: "HELLO",
  claimedTotal: 1400,
  idempotencyKey: "k",
  attempt: 2,
  website: "",
});

describe("the cart across devices (#149)", () => {
  it("carries the cart and details, not a payment attempt", () => {
    const cart = cartOf(payload([
      { sku: "A", qty: 2 }, { sku: "B", qty: 0 }, { sku: "", qty: 1 },
      { sku: "C", qty: 500 },
    ]));

    assert.deepEqual(cart.lines, [{ sku: "A", qty: 2 }, { sku: "C", qty: 99 }]);
    assert.equal(cart.code, "HELLO");
    assert.equal(cart.customer.firstName, "Pat");
    assert.equal(cart.fulfilment.onfarm.window, "morning");
    assert.equal(cart.fulfilment.delivery.address1, "");
    for (const key of ["claimedTotal", "idempotencyKey", "attempt",
      "website"]) {
      assert.equal(key in cart, false, key);
    }
    assert.deepEqual(cartOf("junk").lines, []);
  });

  it("sign-out keeps the cart and none of the customer's details", () => {
    const mine = payload();

    mine.fulfilment = {
      method: "delivery", date: "2026-10-08", delivery: {
        address1: "1 Elm St", town: "Scituate", zip: "02857",
        cooler: "By the door", notes: "Gate code 1234",
      },
    };

    const left = signedOut(mine);

    assert.deepEqual(left.customer, {});
    assert.deepEqual(left.fulfilment, {
      method: "delivery", date: "2026-10-08", delivery: {},
    });
    assert.deepEqual(left.lines, mine.lines);
    assert.equal(left.code, "HELLO");
    // What then goes up to the next account signed in here.
    assert.deepEqual(cartOf(left).fulfilment.delivery, {
      address1: "", address2: "", town: "", zip: "", cooler: "",
      notes: "",
    });
    assert.equal(cartOf(left).customer.email, "");
  });

  it("the copy saved last wins", () => {
    const local = { payload: payload(), savedAt: 200 };

    assert.equal(settle(local, null), "local");
    assert.equal(settle(null, null), null);
    assert.equal(settle(local, { payload: payload(), savedAt: 300 }),
      "remote");
    assert.equal(settle(local, { payload: payload(), savedAt: 100 }),
      "local");
    assert.equal(settle(local, { payload: payload(), savedAt: 200 }), null);
    assert.equal(settle(null, { payload: payload(), savedAt: 100 }),
      "remote");
    // An order placed elsewhere clears an older cart here.
    assert.equal(settle(local, { payload: null, savedAt: 300 }), "remote");
  });

  it("keeps the newer copy and says which stands", async () => {
    const stores = testStores();

    assert.deepEqual(await getCart(stores, pat),
      { ok: true, cart: null, owner: cartOwner(pat.email) });

    const first = await saveCart(stores, pat,
      { payload: payload(), savedAt: T - 1000 }, { now });

    assert.equal(first.kept, true);
    assert.equal(first.cart.payload.idempotencyKey, undefined);

    const older = await saveCart(stores, pat,
      { payload: payload([]), savedAt: T - 2000 }, { now });

    assert.equal(older.kept, false);
    assert.deepEqual(older.cart.payload.lines, [{ sku: "A", qty: 2 }]);

    const cleared = await saveCart(stores, pat,
      { payload: null, savedAt: T - 500 }, { now });

    assert.equal(cleared.kept, true);
    assert.deepEqual((await getCart(stores, pat)).cart,
      { payload: null, savedAt: T - 500 });
  });

  it("brings a fast clock back to the server's", async () => {
    const stores = testStores();
    const saved = await saveCart(stores, pat,
      { payload: payload(), savedAt: T + 60_000 }, { now });

    assert.equal(saved.cart.savedAt, T);
  });

  it("refuses a cart with no time or no shape", async () => {
    const stores = testStores();

    for (const body of [{ payload: payload() }, { payload: "x", savedAt: 1 },
      null, { payload: payload(), savedAt: -1 }]) {
      const result = await saveCart(stores, pat, body, { now });

      assert.equal(result.ok, false);
      assert.equal(result.status, 422);
    }
    assert.equal((await getCart(stores, pat)).cart, null);
  });

  it("goes when the customer does", async () => {
    const stores = testStores();

    await saveCustomer(stores, pat);
    await saveCart(stores, pat, { payload: payload(), savedAt: T }, { now });
    await deleteCustomer(stores, pat.email);
    assert.equal((await getCart(stores, pat)).cart, null);
  });

  it("is routed under the session", async () => {
    const stores = testStores();
    const req = (method, body, cookie) => new Request(
      "https://x/api/account/cart", {
        method,
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          ...(cookie ? { cookie: `nff_session=${cookie}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    assert.equal((await handle(req("GET"), { stores, now })).status, 401);

    const session = await createSession(stores, pat.email, { now });
    const put = await handle(req("PUT", {
      payload: payload(), savedAt: T,
    }, session.id), { stores, now });

    assert.equal(put.status, 200);
    assert.equal((await put.json()).kept, true);

    const got = await handle(req("GET", undefined, session.id),
      { stores, now });

    assert.deepEqual((await got.json()).cart.payload.lines,
      [{ sku: "A", qty: 2 }]);
  });
});

// A browser, enough for the draft and the cart sync: storage, cookies
// and a fetch that answers from `reply` and keeps what was sent.
const browser = ({ cookie = "", reply = () => ({ status: 404 }) } = {}) => {
  const store = () => {
    const m = new Map();

    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  };
  const sent = [];

  const events = [];

  globalThis.window = {
    localStorage: store(), crypto: globalThis.crypto,
    dispatchEvent: (e) => events.push(e.type), addEventListener: () => {},
  };
  globalThis.sessionStorage = store();
  globalThis.document = {
    cookie, dispatchEvent: () => true, getElementById: () => null,
    querySelectorAll: () => [],
  };
  globalThis.fetch = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;

    sent.push({ path, method: init.method || "GET", body });

    const { status = 200, data = {} } = reply(init.method || "GET", body);

    return { status, ok: status < 300, json: async () => data };
  };

  return { sent, events };
};

const SIGNED_IN = "nff_signed_in=1760000000";
const A = cartOwner("alex@example.com");
const B = cartOwner(pat.email);

// A draft Alex left signed in: their details, their address, a cart.
const alexLeft = () => {
  window.localStorage.setItem("nff-order-draft", JSON.stringify({
    key: "k1", savedAt: T - 5000, owner: A,
    payload: {
      ...payload(),
      customer: { firstName: "Alex", lastName: "Doe",
        email: "alex@example.com", phone: "4015550100" },
      fulfilment: { method: "delivery", date: "2026-10-07",
        delivery: { address1: "1 Main St", notes: "Side door" } },
    },
  }));
};

describe("a draft left by another account (#149)", () => {
  it("stray() is true only for a tag that is not the account here", () => {
    assert.equal(stray(A, null), true);
    assert.equal(stray(A, B), true);
    assert.equal(stray(A, A), false);
    assert.equal(stray(A, undefined), false);
    assert.equal(stray(undefined, B), false);
    assert.equal(stray(undefined, null), false);
  });

  it("tags by account, the same whatever the case", () => {
    assert.equal(cartOwner(" Pat@Example.com "), B);
    assert.notEqual(A, B);
    assert.match(B, /^[0-9a-f]{16}$/);
  });

  it("the account refuses a draft tagged for another", async () => {
    const stores = testStores();
    const theirs = await saveCart(stores, pat,
      { payload: payload(), savedAt: T, owner: A }, { now });

    assert.equal(theirs.status, 409);
    assert.equal((await getCart(stores, pat)).cart, null);

    const mine = await saveCart(stores, pat,
      { payload: payload(), savedAt: T, owner: B }, { now });
    const untagged = await saveCart(stores, pat,
      { payload: payload(), savedAt: T + 1 }, { now });

    assert.equal(mine.kept, true);
    assert.equal(mine.owner, B);
    assert.equal(untagged.ok, true);
  });

  it("forgetCustomer drops the details and the tag, keeps the cart", () => {
    browser();
    alexLeft();
    forgetCustomer();

    const draft = new Draft().current();

    assert.equal(draft.owner, undefined);
    assert.deepEqual(draft.payload.customer, {});
    assert.deepEqual(draft.payload.fulfilment.delivery, {});
    assert.deepEqual(draft.payload.lines, [{ sku: "A", qty: 2 }]);
  });

  it("setOwner tags a draft only when it holds something", () => {
    browser();

    const draft = new Draft();

    draft.setOwner(B);
    assert.equal(draft.owner(), undefined);
    draft.save(payload());
    draft.setOwner(B);
    assert.equal(draft.owner(), B);
  });

  it("a signed-out page scrubs it and asks nothing", async () => {
    const { sent } = browser();

    alexLeft();
    assert.equal(scrubStray(null), true);
    assert.deepEqual(new Draft().current().payload.customer, {});

    alexLeft();
    assert.equal(await pullCart(), false);
    assert.equal(new Draft().owner(), undefined);
    await push();
    assert.deepEqual(sent, []);
  });

  it("another account signed in scrubs it before anything goes up",
    async () => {
      const { sent } = browser({
        cookie: SIGNED_IN,
        reply: (method, body) => (method === "GET"
          ? { data: { ok: true, cart: null, owner: B } }
          : { data: { ok: true, kept: true, owner: B, cart: body } }),
      });

      alexLeft();
      assert.equal(await pullCart(), true);

      const up = sent.find((r) => r.method === "PUT");

      assert.ok(up, "the guest cart goes up, as at any sign-in");
      assert.deepEqual(up.body.payload.customer.email, "");
      assert.deepEqual(up.body.payload.fulfilment.delivery.address1, "");
      assert.equal(up.body.owner, B);
      assert.doesNotMatch(JSON.stringify(sent), /alex|Main St|Side door/i);
      assert.equal(new Draft().owner(), B);
    });

  it("a push the account refuses as another's scrubs the draft",
    async () => {
      const { sent } = browser({
        cookie: SIGNED_IN,
        reply: () => ({ status: 409, data: { errors: { owner: "x" } } }),
      });

      alexLeft();
      await push();
      assert.equal(sent[0].body.owner, A);
      assert.equal(new Draft().owner(), undefined);
      assert.deepEqual(new Draft().current().payload.customer, {});
    });

  it("tags the draft with the account it went up under", async () => {
    browser({
      cookie: SIGNED_IN,
      reply: (method, body) => ({
        data: { ok: true, kept: true, owner: B, cart: body },
      }),
    });

    new Draft().save(payload());
    await push();
    assert.equal(new Draft().owner(), B);
  });
});

describe("a session that ended on the server (#149)", () => {
  const stamped = (path, extra = "") => new Request(`https://x${path}`, {
    headers: {
      "Sec-Fetch-Site": "same-origin",
      cookie: `nff_signed_in=abc${extra}`,
    },
  });
  const clears = (res) => (res.headers.get("set-cookie") || "")
    .includes("nff_signed_in=; Path=/; Secure; SameSite=Lax; Max-Age=0");

  it("the account's 401 clears the stamp", async () => {
    const res = await handle(stamped("/api/account/cart", "; nff_session=x"),
      { stores: testStores(), now });

    assert.equal(res.status, 401);
    assert.ok(clears(res));
  });

  it("/api/me clears a stamp with no live session, and only then",
    async () => {
      const stores = testStores();
      const stale = await authHandle(stamped("/api/me"),
        { stores, now, env: {} });

      assert.equal((await stale.json()).signedIn, false);
      assert.ok(clears(stale));

      const bare = await authHandle(new Request("https://x/api/me"),
        { stores, now, env: {} });

      assert.equal(bare.headers.get("set-cookie"), null);
    });

  it("/api/me names the account's cart tag", async () => {
    const stores = testStores();
    const session = await createSession(stores, pat.email, { now });
    const res = await authHandle(new Request("https://x/api/me", {
      headers: { cookie: `nff_session=${session.id}; nff_signed_in=abc` },
    }), { stores, now, env: {} });
    const body = await res.json();

    assert.equal(body.signedIn, true);
    assert.equal(body.owner, cartOwner(pat.email));
    assert.ok(!clears(res));
  });

  it("a pull answered 401 scrubs the draft as signed out", async () => {
    const { sent } = browser({
      cookie: SIGNED_IN,
      reply: () => ({ status: 401, data: { error: "Please sign in." } }),
    });

    alexLeft();
    assert.equal(await pullCart(), true);
    assert.equal(new Draft().owner(), undefined);
    assert.deepEqual(new Draft().current().payload.customer, {});
    assert.equal(sent.filter((r) => r.method === "PUT").length, 0);
  });

  it("a push answered 401 scrubs the draft as signed out", async () => {
    browser({ cookie: SIGNED_IN, reply: () => ({ status: 401 }) });

    alexLeft();
    await push();
    assert.equal(new Draft().owner(), undefined);
    assert.deepEqual(new Draft().current().payload.customer, {});
  });

  it("every scrub tells the page, a 409 included", async () => {
    const refused = browser({
      cookie: SIGNED_IN, reply: () => ({ status: 409 }),
    });

    alexLeft();
    await push();
    assert.deepEqual(refused.events.filter((t) => t === SCRUBBED),
      [SCRUBBED]);

    const out = browser();

    alexLeft();
    scrubStray(null);
    assert.ok(out.events.includes(SCRUBBED));

    const mine = browser();

    alexLeft();
    assert.equal(scrubStray(A), false);
    assert.ok(!mine.events.includes(SCRUBBED), "the owner's own: no scrub");
  });
});
