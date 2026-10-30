// The datastore seam. On Netlify every store is a Netlify Blobs store,
// configured from the function's environment. Anywhere else (tests,
// `netlify functions:serve` without a site) the same interface is
// backed by memory, so the functions run unchanged and nothing is
// silently persisted to the wrong place.
//
// A store holds JSON documents by key and can list keys by prefix.
// Keys use "/" to build small indexes: `order/<id>`, `open/<id>`,
// `by-email/<email>/<id>`.
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

export const STORES = ["orders", "customers", "auth", "stock", "jobs", "gate"];

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

export const wrap = (blobs) => ({
  get: (key) => blobs.get(key, { type: "json" }),
  set: (key, value) => blobs.setJSON(key, value),
  create: async (key, value) => {
    const { modified } = await blobs.setJSON(key, value, { onlyIfNew: true });

    return modified;
  },
  getTagged: async (key) => {
    const found = await blobs.getWithMetadata(key, { type: "json" });

    return found ? { value: found.data, etag: found.etag } : null;
  },
  swap: async (key, value, etag) => {
    const { modified } = await blobs.setJSON(key, value, {
      onlyIfMatch: etag,
    });

    return modified;
  },
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

export const stores = (env = process.env) => {
  const out = {};

  for (const name of STORES) {
    if (blobsConfigured(env)) {
      const onNetlify = !!(env.NETLIFY_BLOBS_CONTEXT
        || globalThis.netlifyBlobsContext);
      const options = onNetlify
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
