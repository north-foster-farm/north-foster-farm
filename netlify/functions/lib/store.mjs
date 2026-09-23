// The datastore seam. On Netlify every store is a Netlify Blobs store,
// configured from the function's environment. Anywhere else (tests,
// `netlify functions:serve` without a site) the same interface is
// backed by memory, so the functions run unchanged and nothing is
// silently persisted to the wrong place.
//
// A store holds JSON documents by key and can list keys by prefix.
// Keys use "/" to build small indexes: `order/<id>`, `open/<id>`,
// `by-email/<email>/<id>`.

import { getStore } from "@netlify/blobs";

export const STORES = ["orders", "customers", "auth", "stock", "jobs"];

// Netlify sets CONTEXT on every deploy and function: production,
// deploy-preview, branch-deploy, dev. Only production uses the bare
// store names. Every other context keeps its own data under a
// prefixed name, so a preview's test order never lands beside a real
// one, and the staging branch's data survives its deploys. The CLI
// reaches a context's stores with --staging or --preview.
export const storeName = (name, env = process.env) => {
  const context = env.CONTEXT || "";

  return context && context !== "production" ? `${context}-${name}` : name;
};

const wrap = (blobs) => ({
  get: (key) => blobs.get(key, { type: "json" }),
  set: (key, value) => blobs.setJSON(key, value),
  delete: (key) => blobs.delete(key),
  // -> [{ key }] with the prefix kept, sorted by key.
  list: async (prefix) => {
    const { blobs: found } = await blobs.list({ prefix });

    return found.map((b) => ({ key: b.key })).sort(
      (a, b) => (a.key < b.key ? -1 : 1)
    );
  },
});

export const memoryStore = (seed = new Map()) => ({
  data: seed,
  get: async (key) => (seed.has(key)
    ? JSON.parse(JSON.stringify(seed.get(key)))
    : null),
  set: async (key, value) => {
    seed.set(key, JSON.parse(JSON.stringify(value)));
  },
  delete: async (key) => {
    seed.delete(key);
  },
  list: async (prefix) => [...seed.keys()]
    .filter((k) => k.startsWith(prefix))
    .sort()
    .map((key) => ({ key })),
});

// Blobs is configured when Netlify runs the function, or when a site
// id and token are given (the CLI does this).
export const blobsConfigured = (env = process.env) =>
  !!(env.NETLIFY_BLOBS_CONTEXT || globalThis.netlifyBlobsContext
    || (env.NETLIFY_SITE_ID && env.NETLIFY_AUTH_TOKEN));

const memory = new Map();

export const stores = (env = process.env) => {
  const out = {};

  for (const name of STORES) {
    if (blobsConfigured(env)) {
      const onNetlify = !!(env.NETLIFY_BLOBS_CONTEXT
        || globalThis.netlifyBlobsContext);
      const options = onNetlify
        ? { name: storeName(name, env), consistency: "strong" }
        : {
          name: storeName(name, env),
          consistency: "strong",
          siteID: env.NETLIFY_SITE_ID,
          token: env.NETLIFY_AUTH_TOKEN,
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
