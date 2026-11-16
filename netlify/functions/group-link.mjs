// A group's short link (#587): GET /<group key>, as /vff, answers 302
// to the group's sign-up page with the join token in force, read from
// the group's record now, so the token is never in this public repo
// and a replaced one is followed at once. A 302 with no-store, never a
// 301, so no browser or link preview keeps an old token. A group with
// no record yet gets its token minted, as the Membership tab does.
//
// Netlify reads `config.path` as literals only (#577), so it lists the
// keys of data/groups.json by hand, each with and without the trailing
// slash; test/group-link.test.mjs fails until a new group's are added.
// A read, so no log line (docs/security.md, Logging).

import { groupOf, joinPath, joinTokenOf } from "./lib/groups.mjs";
import { withLog } from "./lib/log.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

const notFound = () => new Response("Not found.", {
  status: 404,
  headers: { "Content-Type": "text/plain; charset=utf-8" },
});

export const handle = async (req, { stores = defaultStores() } = {}) => {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound();

  const key = new URL(req.url).pathname.replace(/^\/+|\/+$/g, "");

  if (!config.path.includes(`/${key}`) || !groupOf(key)) return notFound();

  return new Response(null, {
    status: 302,
    headers: {
      Location: joinPath(await joinTokenOf(stores, key)),
      "Cache-Control": "no-store",
    },
  });
};

export default withLog("group-link", async (req) => handle(req));

export const config = {
  path: ["/vff", "/vff/"],
};
