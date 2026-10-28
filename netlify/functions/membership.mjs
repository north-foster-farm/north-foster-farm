// The Membership tab (#495, part 5):
//
//   GET  /api/membership            a member's and a host's view
//   GET  /api/membership/qr         ?group=<key> the host's join QR
//                                   code, as SVG; &download=1 saves it
//                                   as a file
//   POST /api/membership/qr         { group, rotate: true } the host
//                                   replaces it; the old one stops at
//                                   once
//   POST /api/membership/remove     { group, email } the host takes a
//                                   member out (#495, part 6)
//   POST /api/membership/leave      {} a member leaves their own group
//
// 401 with no session. Anyone who is neither a group's member nor a
// host gets 404. A host's request names the group it acts on, and
// gets 404 unless this address hosts that group, so a member, another
// group's host or a host naming the group they belong to gets nothing:
// nothing says whether there is anything there. The host's POSTs get
// 403 unless they come from this origin (Sec-Fetch-Site same-origin,
// or an Origin naming this host); same-site is not enough.

import terms from "./lib/terms.mjs";
import {
  normalizeEmail, sameOrigin, sameSite, sessionFrom,
} from "./lib/auth.mjs";
import { now as clock } from "./lib/clock.mjs";
import { audit } from "./lib/group-log.mjs";
import {
  joinQr, joinTokenOf, rotateJoinToken,
} from "./lib/groups.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { gate } from "./lib/maintenance.mjs";
import {
  hostMembers, hostedBy, membershipView, removeMember, roleOf,
} from "./lib/membership.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

const NOTHING = () => json(404, { error: "Not found." });

const PATHS = [
  "/api/membership", "/api/membership/qr", "/api/membership/remove",
  "/api/membership/leave",
];

// Draft wording for James.
export const SELF = "To leave the group yourself, use Leave group.";
export const NOT_IN = "That person isn't in the group.";

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

  if (!PATHS.includes(path)) return NOTHING();
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

  // A member's own Leave group, with its confirmation on the page.
  if (path === "/api/membership/leave" && req.method === "POST") {
    if (!role.member) return NOTHING();

    const closed = await gate(stores);

    if (closed) return closed;

    await removeMember(stores, role.member.key, session.email, {
      by: { role: "member", email: session.email }, action: "member.leave",
      now,
    });

    return json(200, { ok: true });
  }

  // Everything past here is a host's alone, on the hosted group the
  // request names, and the host's changes come from this origin only,
  // not merely this site.
  if (role.hosts.length === 0) return NOTHING();
  if (req.method === "POST" && !sameOrigin(req)) {
    return json(403, { error: "Cross-origin request." });
  }

  const body = req.method === "POST" ? await readJson(req) : null;
  const hosted = hostedBy(role, req.method === "POST"
    ? body && body.group : url.searchParams.get("group"));

  if (!hosted) return NOTHING();

  const { key, name } = hosted;
  const by = { role: "host", email: session.email };

  if (path === "/api/membership/remove" && req.method === "POST") {
    const closed = await gate(stores);

    if (closed) return closed;

    const email = typeof body.email === "string"
      ? normalizeEmail(body.email) : "";

    if (!email) return json(400, { errors: { email: "Expected an email." } });
    if (email === session.email) {
      return json(422, { ok: false, message: SELF });
    }

    const r = await removeMember(stores, key, email, { by, now });

    if (!r.ok) return json(404, { ok: false, message: NOT_IN });

    return json(200, { ok: true, members: await hostMembers(stores, key) });
  }

  if (path === "/api/membership/qr" && req.method === "GET") {
    const token = await joinTokenOf(stores, key, { now });

    return svg(joinQr(token, name, { env }).svg, {
      download: url.searchParams.get("download") === "1", key,
    });
  }

  if (path === "/api/membership/qr" && req.method === "POST") {
    const closed = await gate(stores);

    if (closed) return closed;

    if (body.rotate !== true) {
      return json(400, { errors: { body: "Expected { rotate: true }." } });
    }

    const record = await rotateJoinToken(stores, key, { now });

    await audit(stores, { group: key, by, action: "qr.rotate", now });

    return json(200, { ok: true, qr: { setAt: record.joinTokenSetAt } });
  }

  return NOTHING();
};

export default withLog("membership", async (req) => handle(req));

export const config = { path: PATHS };
