// The access gate, at Netlify's edge, in front of every request to a
// non-production deploy. All of its decisions are in
// netlify/functions/lib/gate-edge.mjs; this file only hands it what
// the platform knows. In production the deploy context is
// "production" and the request passes untouched, before any store is
// opened. If this function fails, the request fails with it (the
// default onError), so the gate cannot fall open.

/* global Netlify */

import { getStore } from "@netlify/blobs";

import { gateRequest } from "../functions/lib/gate-edge.mjs";

// The same store the functions and the CLI use: the gate's, named for
// the deploy context (lib/store.mjs, storeName).
const blobs = (deploy) => {
  const store = getStore({ name: `${deploy}-gate`, consistency: "strong" });

  return {
    get: (key) => store.get(key, { type: "json" }),
    set: (key, value) => store.setJSON(key, value),
    delete: (key) => store.delete(key),
    list: async (prefix) => {
      const { blobs: found } = await store.list({ prefix });

      return found.map((b) => ({ key: b.key }));
    },
  };
};

export default async (request, context) => gateRequest(request, {
  deploy: context.deploy && context.deploy.context,
  env: (name) => Netlify.env.get(name),
  store: () => blobs(context.deploy.context),
  next: () => context.next(),
});

export const config = {
  path: "/*",
};
