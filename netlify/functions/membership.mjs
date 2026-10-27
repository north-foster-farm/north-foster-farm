// The Membership tab (#495, part 5):
//
//   GET  /api/membership            a member's or the host's view
//   GET  /api/membership/qr         the host's join QR code, as SVG;
//                                   ?download=1 saves it as a file
//   POST /api/membership/qr         { rotate: true } the host replaces
//                                   it; the old one stops at once
//
// 401 with no session. Anyone who is neither the group's member nor
// its host gets 404, and a member asking for a host's part gets 404
// too: nothing says whether there is anything there.

import terms from "./lib/terms.mjs";
import { sameSite, sessionFrom } from "./lib/auth.mjs";
import { now as clock } from "./lib/clock.mjs";
import { audit } from "./lib/group-log.mjs";
import {
  joinPath, joinTokenOf, rotateJoinToken,
} from "./lib/groups.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { gate } from "./lib/maintenance.mjs";
import { membershipView, roleOf } from "./lib/membership.mjs";
import { qrSvg } from "./lib/qr.mjs";
import { siteUrl } from "./lib/site.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

const NOTHING = () => json(404, { error: "Not found." });

// The QR code, the current token's, never cached: after a rotation
// the next request is the new one.
const svg = (body, { download, key }) => new Response(body, {
  status: 200,
  headers: {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(download
      ? { "Content-Disposition": `attachment; filename="join-${key}-qr.svg"` }
      : {}),
  },
});

export const handle = async (req, {
  stores = defaultStores(),
  env = process.env,
  now = clock(),
} = {}) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (!["/api/membership", "/api/membership/qr"].includes(path)) {
    return NOTHING();
  }
  if (req.method === "POST" && !sameSite(req)) {
    return json(403, { error: "Cross-site request." });
  }

  const session = await sessionFrom(stores, req, { now });

  if (!session) return json(401, { error: "Sign in first." });

  const role = await roleOf(stores, session);

  if (!role) return NOTHING();

  if (path === "/api/membership" && req.method === "GET") {
    return json(200, await membershipView(stores, role, { terms, now }),
      { "Cache-Control": "no-store" });
  }

  // Everything past here is the host's alone.
  if (!role.host) return NOTHING();

  const { key, name } = role.group;
  const by = { role: "host", email: session.email };

  if (path === "/api/membership/qr" && req.method === "GET") {
    const token = await joinTokenOf(stores, key, { now });

    return svg(qrSvg(`${siteUrl(env)}${joinPath(token)}`, {
      title: `Join ${name}`,
    }), { download: url.searchParams.get("download") === "1", key });
  }

  if (path === "/api/membership/qr" && req.method === "POST") {
    const closed = await gate(stores);

    if (closed) return closed;

    const body = await readJson(req);

    if (!body || body.rotate !== true) {
      return json(400, { errors: { body: "Expected { rotate: true }." } });
    }

    const record = await rotateJoinToken(stores, key, { now });

    await audit(stores, { group: key, by, action: "qr.rotate", now });

    return json(200, { ok: true, qr: { setAt: record.joinTokenSetAt } });
  }

  return NOTHING();
};

export default withLog("membership", async (req) => handle(req));

export const config = {
  path: ["/api/membership", "/api/membership/qr"],
};
