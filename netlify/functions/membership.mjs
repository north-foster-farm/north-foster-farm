// The Membership tab (#495, part 5):
//
//   GET  /api/membership            a member's and a host's view; a
//                                   host's holds the join link (#579),
//                                   the group's short link (#589)
//   GET  /api/membership/qr         ?group=<key> the host's join QR
//                                   code, the short link as SVG;
//                                   &download=1 saves it as a file
//   POST /api/membership/remove     { group, email } the host takes a
//                                   member out (#495, part 6)
//   POST /api/membership/leave      {} a member leaves their own group
//   GET  /api/membership/code       the member's own code (#131) as a
//                                   QR code, SVG; &download=1 saves it
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
  receivedEmail, sameOrigin, sameSite, sessionFrom,
} from "./lib/auth.mjs";
import { now as clock } from "./lib/clock.mjs";
import { joinQr } from "./lib/groups.mjs";
import { json, readJson } from "./lib/http.mjs";
import { withLog } from "./lib/log.mjs";
import { gate } from "./lib/maintenance.mjs";
import {
  hostMembers, hostedBy, memberCode, memberCodeSvg, membershipView,
  removeMember, roleOf,
} from "./lib/membership.mjs";
import { stores as defaultStores } from "./lib/store.mjs";

const NOTHING = () => json(404, { error: "Not found." });

// Netlify reads `config` from the source at build time and takes only
// literals: a path named by a variable deploys with no route at all,
// and every request falls through to the site's 404 (#577). The
// handler checks this same list, so there is one copy.
// test/function-config.test.mjs holds every function to it.
export const config = {
  path: [
    "/api/membership", "/api/membership/qr", "/api/membership/remove",
    "/api/membership/leave", "/api/membership/code",
  ],
};

// Draft wording for James.
export const SELF = "To leave the group yourself, use Leave group.";
export const NOT_IN = "That person isn't in the group.";

// A QR code, never cached: the member's code can change, and the
// host's is drawn fresh with the site's address.
const svg = (body, { download, name }) => new Response(body, {
  status: 200,
  headers: {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(download
      ? { "Content-Disposition": `attachment; filename="${name}"` }
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

  if (!config.path.includes(path)) return NOTHING();
  if (req.method === "POST" && !sameSite(req)) {
    return json(403, { error: "Cross-site request." });
  }

  const session = await sessionFrom(stores, req, { now });

  if (!session) return json(401, { error: "Sign in first." });

  const role = await roleOf(stores, session);

  if (!role) return NOTHING();

  if (path === "/api/membership" && req.method === "GET") {
    // A member's first look mints their code (#131), a write, which
    // waits while the site is in maintenance.
    const mint = role.member ? !(await gate(stores)) : false;

    return json(200, await membershipView(stores, role, {
      terms, now, email: session.email, mint, env,
    }),{ "Cache-Control": "no-store" });
  }

  // The member's own code as a QR code (#131), for the tab and the key
  // tag. Only one already minted: the tab asks /api/membership first.
  if (path === "/api/membership/code" && req.method === "GET") {
    if (!role.member) return NOTHING();

    const code = await memberCode(stores, session.email, { now, mint: false });

    if (!code) return NOTHING();

    return svg(memberCodeSvg(code.id), {
      download: url.searchParams.get("download") === "1",
      name: `member-code-${code.id}.svg`,
    });
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

    // Decoded once, cleaned and checked (#758).
    const email = receivedEmail(body.email);

    if (!email) {
      return json(400, {
        errors: { email: "Expected a valid email address." },
      });
    }
    if (email === session.email) {
      return json(422, { ok: false, message: SELF });
    }

    const r = await removeMember(stores, key, email, { by, now });

    if (!r.ok) return json(404, { ok: false, message: NOT_IN });

    return json(200, { ok: true, members: await hostMembers(stores, key) });
  }

  // The short link drawn (#589), so the code reads nothing from the
  // record and no poster ever needs replacing. The host has no
  // replacement: with the short link following the token, a new one
  // would stop no one. The farm replaces a leaked long link with
  // `bin/nff groups qr <key> --rotate`.
  if (path === "/api/membership/qr" && req.method === "GET") {
    return svg(joinQr(key, name, { env }).svg, {
      download: url.searchParams.get("download") === "1",
      name: `join-${key}-qr.svg`,
    });
  }

  return NOTHING();
};

export default withLog("membership", async (req) => handle(req));
