// The datastore seam. On Netlify every store is a Netlify Blobs store,
// configured from the function's environment. Anywhere else (tests,
// `netlify functions:serve` without a site) the same interface is
// backed by memory, so the functions run unchanged and nothing is
// silently persisted to the wrong place.
//
// A store holds JSON documents by key and can list keys by prefix.
// Keys use "/" to build small indexes: `order/<id>`, `open/<id>`,
// `by-email/<hash>/<id>`, an address hashed (lib/address-key.mjs).
//
// `create(key, value)` writes only if the key is new and says whether
// it did: Blobs' `onlyIfNew`, a conditional write the server decides,
// so of two racing creates exactly one wins (#253).
//
// `getTagged(key)` reads a document with its etag, -> { value, etag }
// or null, and `swap(key, value, etag)` writes it only if the etag
// still matches and says whether it did: Blobs' `onlyIfMatch`, so of
// two racing changes to one document exactly one wins (#301).

import { getStore } from "@netlify/blobs";

import { log } from "./log.mjs";
import { maskEmail } from "./mask.mjs";
import { ORDER_ID } from "./order-id.mjs";

// `recordings` holds the PayPal recorder's window and records (#708,
// lib/recorder.mjs): private, never backed up, and pruned after 7 days.
// `invites` holds the farm's invite links (#718, lib/invites.mjs).
export const STORES = [
  "orders", "customers", "auth", "stock", "jobs", "gate", "recordings",
  "invites",
];

// Netlify sets CONTEXT at build time only; a function sees nothing of
// it (checked 2026-09-23). SITE_CONTEXT is a variable with a value
// per context on Netlify (production, deploy-preview, branch-deploy,
// dev) and is what the functions read. Only production uses the bare
// store names. Every other context keeps its own data under a
// prefixed name, so a preview's test order never lands beside a real
// one, and the staging branch's data survives its deploys. The CLI
// reaches a context's stores with --staging or --preview.
// -> "production", "deploy-preview", "branch-deploy", "dev" or "".
export const deployContext = (env = process.env) =>
  env.SITE_CONTEXT || env.CONTEXT || "";

export const storeName = (name, env = process.env) => {
  const context = deployContext(env);

  return context && context !== "production" ? `${context}-${name}` : name;
};

// A key in a log line: its kind kept, an email address in it masked as
// lib/mask.mjs masks one (#496) and an order id the same way, and any
// other part hidden in full. That covers a pass code, a bearer code
// of which a few characters narrow the guesses (#683), and a member
// id. customer/pat@example.com -> customer/***@exa*****com,
// pass/ABCD-EFGH -> pass/***.
const maskSegment = (part) => {
  if (!part) return part;

  return part.includes("@") || ORDER_ID.test(part) ? maskEmail(part) : "***";
};

export const maskKey = (key) => {
  const [kind, ...rest] = String(key).split("/");

  return [kind, ...rest.map(maskSegment)].join("/");
};

// A conditional write (`onlyIfMatch` or `onlyIfNew`) -> whether the
// store took it (#677). Blobs' client calls a 412 or a 409 refused and
// throws a BlobsInternalError, carrying the status, on a 5xx it has
// stopped retrying (@netlify/blobs 11.1.9, Store#setJSON); a 5xx is
// caught here and settled like any other answer. The status it got is
// on the trace span a caller may pass it (its typed `span` option), so
// a 200 is a write made. Any other answer is
// settled by reading the key back: this write's own value there means
// the store took it and only the answer was lost (a 5xx after storing
// it, or the 412 the client's retry of it met), so the caller does not
// make it twice. Anything else is a write not made, which the caller
// reads again and retries as it does a lost race.
const conditional = async (blobs, key, value, condition) => {
  let status = null;
  const span = {
    setAttributes: (attributes) => {
      if ("blobs.response.status" in attributes) {
        status = attributes["blobs.response.status"];
      }
    },
  };

  try {
    await blobs.setJSON(key, value, { ...condition, span });
  } catch (error) {
    if (error.name !== "BlobsInternalError" || !(error.status >= 500)) {
      throw error;
    }
    status = error.status;
  }
  if (status === 200) return { made: true };

  const stored = await blobs.get(key, { type: "json" });
  const made = stored !== null
    && JSON.stringify(stored) === JSON.stringify(value);

  log.warn({
    event: made ? "blobs.answer_lost" : "blobs.write_refused",
    store: String(blobs.name || "").replace(/^site:/, ""),
    key: maskKey(key), status,
  });

  return { made, stored, status };
};

export const wrap = (blobs) => ({
  get: (key) => blobs.get(key, { type: "json" }),
  set: (key, value) => blobs.setJSON(key, value),
  // A create refused by anything but a 412 while the key is still
  // empty is no lost race: nobody else holds the key, so it throws
  // rather than say somebody does.
  create: async (key, value) => {
    const { made, stored, status } = await conditional(blobs, key, value, {
      onlyIfNew: true,
    });

    if (!made && stored === null && status !== 412) {
      throw new Error(`The store refused to create ${maskKey(key)}.`);
    }

    return made;
  },
  getTagged: async (key) => {
    const found = await blobs.getWithMetadata(key, { type: "json" });

    return found ? { value: found.data, etag: found.etag } : null;
  },
  swap: async (key, value, etag) =>
    (await conditional(blobs, key, value, { onlyIfMatch: etag })).made,
  delete: (key) => blobs.delete(key),
  // -> [{ key }] with the prefix kept, sorted by key.
  list: async (prefix) => {
    const { blobs: found } = await blobs.list({ prefix });

    return found.map((b) => ({ key: b.key })).sort(
      (a, b) => (a.key < b.key ? -1 : 1)
    );
  },
});

// Every write gives the key a new etag, as Blobs does.
export const memoryStore = (seed = new Map()) => {
  const tags = new Map();
  let next = 0;
  const put = (key, value) => {
    seed.set(key, JSON.parse(JSON.stringify(value)));
    next += 1;
    tags.set(key, `m${next}`);
  };
  const tagOf = (key) => {
    if (!tags.has(key)) {
      next += 1;
      tags.set(key, `m${next}`);
    }

    return tags.get(key);
  };

  return {
    data: seed,
    get: async (key) => (seed.has(key)
      ? JSON.parse(JSON.stringify(seed.get(key)))
      : null),
    set: async (key, value) => {
      put(key, value);
    },
    // Check and write with no await between them: atomic in one
    // process.
    create: async (key, value) => {
      if (seed.has(key)) return false;
      put(key, value);

      return true;
    },
    getTagged: async (key) => (seed.has(key)
      ? { value: JSON.parse(JSON.stringify(seed.get(key))), etag: tagOf(key) }
      : null),
    swap: async (key, value, etag) => {
      if (!seed.has(key) || tagOf(key) !== etag) return false;
      put(key, value);

      return true;
    },
    delete: async (key) => {
      seed.delete(key);
      tags.delete(key);
    },
    list: async (prefix) => [...seed.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({ key })),
  };
};

// Blobs is configured when Netlify runs the function, or when a site
// id and token are given (the CLI does this).
export const blobsConfigured = (env = process.env) =>
  !!(env.NETLIFY_BLOBS_CONTEXT || globalThis.netlifyBlobsContext
    || (env.NETLIFY_SITE_ID && env.NETLIFY_AUTH_TOKEN));

// Whether this is a function Netlify runs, rather than the CLI or a
// test.
export const onNetlify = (env = process.env) => !!(env.NETLIFY_BLOBS_CONTEXT
  || globalThis.netlifyBlobsContext);

const memory = new Map();

// Blobs answers that its client retries: a 429, a 5xx, or no answer
// at all. Without a rate-limit header it sleeps 5 s before each retry
// (@netlify/blobs 11.1.0, src/retry.ts), which is the 5.5 s of every
// e2e call on staging (#516). One line per such answer, with the store,
// method and status, never the key or URL (a key can hold an email).
export const watchedFetch = (name, fetchImpl = null) =>
  async (url, options = {}) => {
    const method = options.method || "get";

    try {
      const res = await (fetchImpl || globalThis.fetch)(url, options);

      if (res.status === 429 || res.status >= 500) {
        log.warn({
          event: "blobs.retryable", store: name, method, status: res.status,
          rateLimitReset: res.headers.get("X-RateLimit-Reset") !== null,
        });
      }

      return res;
    } catch (error) {
      log.warn({
        event: "blobs.retryable", store: name, method, status: null,
        error: String((error && error.message) || error).slice(0, 200),
      });
      throw error;
    }
  };

// What Blobs still needs off Netlify -> the variables missing, in
// order: [] when it is configured.
export const blobsMissing = (env = process.env) => {
  if (blobsConfigured(env)) return [];

  return ["NETLIFY_SITE_ID", "NETLIFY_AUTH_TOKEN"]
    .filter((key) => !env[key]);
};

// `{ memory: false }` refuses the memory fallback: the CLI under a
// context flag, where a write that lands in memory reports success and
// saves nothing (#713). It throws, naming what is missing, before any
// store is made.
export const stores = (env = process.env, options = {}) => {
  const allowMemory = options.memory !== false;
  const missing = blobsMissing(env);

  if (!allowMemory && missing.length) {
    throw new Error(`No ${missing.join(" or ")}: refusing memory stores, ` +
      "which would lose every write.");
  }

  const out = {};

  for (const name of STORES) {
    if (blobsConfigured(env)) {
      const options = onNetlify(env)
        ? {
          name: storeName(name, env), consistency: "strong",
          fetch: watchedFetch(name),
        }
        : {
          name: storeName(name, env),
          consistency: "strong",
          siteID: env.NETLIFY_SITE_ID,
          token: env.NETLIFY_AUTH_TOKEN,
          fetch: watchedFetch(name),
        };

      out[name] = wrap(getStore(options));
    } else {
      if (!memory.has(name)) memory.set(name, memoryStore());
      out[name] = memory.get(name);
    }
  }

  out.persistent = blobsConfigured(env);

  return out;
};

// A fresh set of memory stores for a test.
export const testStores = () => {
  const out = {};

  for (const name of STORES) out[name] = memoryStore();
  out.persistent = false;

  return out;
};
