// The Membership tab (#495, part 5): a member sees the group's name,
// place and rounds; the host also gets the QR code, its replacement and
// the member list; anyone else gets nothing, and the tab and the menu
// entry show for neither.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { handle } from "../netlify/functions/membership.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { auditLog } from "../netlify/functions/lib/group-log.mjs";
import {
  GROUPS, findGroupByToken, joinGroup, joinTokenOf, memberKeyOf,
  setGroupCode, setGroupHost,
} from "../netlify/functions/lib/groups.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import { roleOf, roundsNow } from "../netlify/functions/lib/membership.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import {
  JOIN_WAYS, hours, joinedLine, moment, roundsLine,
} from "../assets/scripts/account/lib/membership.mjs";

const now = new Date("2026-11-02T14:00:00Z");
const env = { URL: "https://x" };
const HOST = "host@example.com";
const PAT = "pat@example.com";
const STRANGER = "stranger@example.com";

const setup = async () => {
  const stores = testStores();

  await setGroupCode(stores, "vff", { code: "GYM-2026", now });
  await setGroupHost(stores, "vff", HOST, { now });
  for (const [email, first] of [[HOST, "Hal"], [PAT, "Pat"],
    [STRANGER, "Sam"]]) {
    await saveCustomer(stores, { email, firstName: first,
      lastName: "Example", name: `${first} Example` });
  }
  await joinGroup(stores, HOST, "vff", { now, via: "farm" });
  await joinGroup(stores, PAT, "vff", { now, via: "qr" });

  const cookie = async (email) => ({
    cookie: `nff_session=${(await createSession(stores, email, { now })).id}`,
  });

  return {
    stores,
    host: await cookie(HOST),
    member: await cookie(PAT),
    stranger: await cookie(STRANGER),
  };
};

const call = (stores, path, { method = "GET", headers = {}, body } = {}) =>
  handle(new Request(`http://x${path}`, {
    method,
    // As the account page's own fetch sends it.
    headers: {
      "Content-Type": "application/json", "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  }), { stores, env, now });

const me = async (stores, headers) => (await authHandle(
  new Request("http://x/api/me", { headers }), { stores, env, now })).json();

describe("who gets what", () => {
  it("tells no one without a session anything", async () => {
    const { stores } = await setup();

    for (const path of ["/api/membership", "/api/membership/qr"]) {
      assert.equal((await call(stores, path)).status, 401);
    }
  });

  it("gives a stranger nothing at all", async () => {
    const { stores, stranger } = await setup();

    for (const [path, method, body] of [
      ["/api/membership", "GET"], ["/api/membership/qr?group=vff", "GET"],
      ["/api/membership/qr", "POST", { group: "vff", rotate: true }],
    ]) {
      const res = await call(stores, path, { method, headers: stranger, body });

      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  it("gives a member the group, its place and rounds, and no more",
    async () => {
      const { stores, member } = await setup();
      const res = await call(stores, "/api/membership", { headers: member });
      const view = await res.json();

      assert.equal(res.status, 200);
      assert.equal(view.member.key, "vff");
      assert.equal(view.member.group.name, "The Village Family Fitness");
      assert.equal(typeof view.member.group.place.street, "string");
      assert.equal(view.member.rounds.current.date, "2026-11-08");
      assert.equal(view.member.members, undefined);
      assert.equal(view.member.qr, undefined);
      assert.deepEqual(view.hosts, []);

      assert.equal((await call(stores, "/api/membership/qr?group=vff",
        { headers: member })).status, 404);
      assert.equal((await call(stores, "/api/membership/qr", {
        method: "POST", headers: member, body: { group: "vff", rotate: true },
      })).status, 404);
    });

  it("gives the host the members and the QR code", async () => {
    const { stores, host } = await setup();
    const view = await (await call(stores, "/api/membership",
      { headers: host })).json();
    const [hosted] = view.hosts;

    assert.equal(view.hosts.length, 1);
    assert.equal(hosted.key, "vff");
    assert.deepEqual(hosted.members.map((m) => [m.email, m.name, m.via]),
      [[HOST, "Hal Example", "farm"], [PAT, "Pat Example", "qr"]]);
    assert.deepEqual(Object.keys(hosted.members[0]).sort(),
      ["email", "joinedAt", "name", "via"], "nothing past these");

    const qr = await call(stores, "/api/membership/qr?group=vff",
      { headers: host });

    assert.equal(qr.status, 200);
    assert.match(qr.headers.get("content-type"), /^image\/svg\+xml/);
    assert.equal(qr.headers.get("cache-control"), "no-store");
    assert.match(await qr.text(), /^<svg /);

    const saved = await call(stores,
      "/api/membership/qr?group=vff&download=1", { headers: host });

    assert.match(saved.headers.get("content-disposition"),
      /^attachment; filename="join-vff-qr\.svg"$/);
  });

  it("lets the host replace the QR code, logged, the old one dead",
    async () => {
      const { stores, host } = await setup();
      const old = await joinTokenOf(stores, "vff", { now });
      const res = await call(stores, "/api/membership/qr", {
        method: "POST", headers: host, body: { group: "vff", rotate: true },
      });

      assert.equal(res.status, 200);
      assert.equal(await findGroupByToken(stores, old), null);

      const [act] = await auditLog(stores, "vff");

      assert.deepEqual([act.by, act.action], [
        { role: "host", email: maskEmail(HOST) }, "qr.rotate",
      ]);
    });

  it("refuses a rotation from another site", async () => {
    const { stores, host } = await setup();
    const res = await call(stores, "/api/membership/qr", {
      method: "POST", body: { group: "vff", rotate: true },
      headers: { ...host, "sec-fetch-site": "cross-site" },
    });

    assert.equal(res.status, 403);
  });

  // The coordinator's security review: same-site lets a sibling
  // (a deploy preview, a branch subdomain) act as the host.
  it("refuses a rotation that is same-site but not same-origin",
    async () => {
      const { stores, host } = await setup();
      const old = await joinTokenOf(stores, "vff", { now });
      const rotate = (headers) => call(stores, "/api/membership/qr", {
        method: "POST", body: { group: "vff", rotate: true },
        headers: { ...host, ...headers },
      });

      for (const headers of [
        { "sec-fetch-site": "same-site" },
        { "sec-fetch-site": "none" },
        { "sec-fetch-site": "", origin: "http://preview.x" },
        { "sec-fetch-site": "" },
      ]) {
        assert.equal((await rotate(headers)).status, 403,
          JSON.stringify(headers));
      }
      assert.equal((await findGroupByToken(stores, old)).key, "vff");
      assert.deepEqual(await auditLog(stores, "vff"), []);

      // A browser with no Sec-Fetch-Site but this Origin is let in.
      assert.equal((await rotate({ "sec-fetch-site": "", origin: "http://x" }))
        .status, 200);
    });

  it("flags the tab in /api/me for a member and the host only",
    async () => {
      const { stores, host, member, stranger } = await setup();

      assert.equal((await me(stores, host)).membership, true);
      assert.equal((await me(stores, member)).membership, true);
      assert.equal((await me(stores, stranger)).membership, undefined);
    });
});

// QA item 4 (James, 6458200999): membership and hosting are worked
// out apart. The member's own group gets the member view, every group
// the address hosts gets the host view, and a host acts only on a
// hosted group the request names. Only one group is in the data, so a
// second one stands in for these tests.
describe("a member of one group who hosts another", () => {
  const OTHER = { ...GROUPS[0], key: "gym2", name: "Second Gym" };
  const ROB = "rob@example.com";

  before(() => GROUPS.push(OTHER));
  after(() => GROUPS.splice(GROUPS.indexOf(OTHER), 1));

  // The setup above, and Rob in the second group.
  const twoGroups = async () => {
    const s = await setup();

    await saveCustomer(s.stores, { email: ROB, firstName: "Rob",
      lastName: "Example", name: "Rob Example" });
    await joinGroup(s.stores, ROB, "gym2", { now, via: "farm" });

    return s;
  };

  const roleKeys = async (stores, email) => {
    const r = await roleOf(stores,
      { email, customer: await getCustomer(stores, email) });

    return r && {
      member: r.member && r.member.key, hosts: r.hosts.map((g) => g.key),
    };
  };

  it("works out the roles apart", async () => {
    const { stores } = await twoGroups();

    // Member only, and member and host of the same group.
    assert.deepEqual(await roleKeys(stores, PAT),
      { member: "vff", hosts: [] });
    assert.deepEqual(await roleKeys(stores, HOST),
      { member: "vff", hosts: ["vff"] });
    assert.equal(await roleKeys(stores, STRANGER), null);

    // Host only.
    await setGroupHost(stores, "gym2", STRANGER, { now });
    assert.deepEqual(await roleKeys(stores, STRANGER),
      { member: null, hosts: ["gym2"] });

    // Member of A, hosting B.
    await setGroupHost(stores, "gym2", PAT, { now });
    assert.deepEqual(await roleKeys(stores, PAT),
      { member: "vff", hosts: ["gym2"] });

    // Hosting two.
    await setGroupHost(stores, "gym2", HOST, { now });
    assert.deepEqual(await roleKeys(stores, HOST),
      { member: "vff", hosts: ["vff", "gym2"] });
  });

  it("shows the member's own group and the hosted one, each in its part",
    async () => {
      const { stores, member } = await twoGroups();

      await setGroupHost(stores, "gym2", PAT, { now });

      const view = await (await call(stores, "/api/membership",
        { headers: member })).json();

      assert.equal(view.member.key, "vff");
      assert.equal(view.member.members, undefined, "not vff's host");
      assert.deepEqual(view.hosts.map((h) => h.key), ["gym2"]);
      assert.equal(view.hosts[0].group.name, "Second Gym");
      assert.deepEqual(view.hosts[0].members.map((m) => m.email), [ROB]);
      assert.equal((await me(stores, member)).membership, true);
    });

  it("acts only on the hosted group named, never the member's own",
    async () => {
      const { stores, member } = await twoGroups();

      await setGroupHost(stores, "gym2", PAT, { now });

      const vff = await joinTokenOf(stores, "vff", { now });
      const gym = await joinTokenOf(stores, "gym2", { now });
      const rotate = (group) => call(stores, "/api/membership/qr", {
        method: "POST", headers: member, body: { group, rotate: true },
      });
      const remove = (body) => call(stores, "/api/membership/remove",
        { method: "POST", headers: member, body });

      // The group they belong to, none named, or one they don't host.
      for (const group of ["vff", undefined, "nope"]) {
        assert.equal((await rotate(group)).status, 404, String(group));
        assert.equal((await call(stores,
          `/api/membership/qr?group=${group || ""}`, { headers: member }))
          .status, 404, String(group));
      }
      assert.equal((await remove({ group: "vff", email: HOST })).status, 404);
      assert.equal((await remove({ email: HOST })).status, 404);
      assert.equal((await findGroupByToken(stores, vff)).key, "vff");
      assert.equal(memberKeyOf(await getCustomer(stores, HOST)), "vff");
      assert.deepEqual(await auditLog(stores, "vff"), []);

      // The one they host.
      assert.equal((await call(stores, "/api/membership/qr?group=gym2",
        { headers: member })).status, 200);
      assert.equal((await rotate("gym2")).status, 200);
      assert.equal(await findGroupByToken(stores, gym), null);

      const out = await remove({ group: "gym2", email: ROB });

      assert.equal(out.status, 200);
      assert.deepEqual((await out.json()).members, []);
      assert.equal(memberKeyOf(await getCustomer(stores, ROB)), null);
    });

  it("takes a host of two only out of the group named", async () => {
    const { stores, host } = await twoGroups();

    await setGroupHost(stores, "gym2", HOST, { now });

    const view = await (await call(stores, "/api/membership",
      { headers: host })).json();

    assert.deepEqual(view.hosts.map((h) => h.key), ["vff", "gym2"]);

    // Pat is in vff, not gym2: naming gym2 finds no one to remove.
    const res = await call(stores, "/api/membership/remove", {
      method: "POST", headers: host, body: { group: "gym2", email: PAT },
    });

    assert.equal(res.status, 404);
    assert.equal(memberKeyOf(await getCustomer(stores, PAT)), "vff");
  });
});

describe("the rounds", () => {
  it("are the one being ordered for and the next", () => {
    const group = { series: "36TS" };
    const r = roundsNow(group, terms, now);

    assert.equal(r.every, 2);
    assert.deepEqual(r.current, {
      date: "2026-11-08", closesAt: "2026-11-08T04:59:00.000Z",
    });
    assert.deepEqual(r.next, {
      date: "2026-11-22", opensAt: "2026-11-08T04:59:00.000Z",
    });
  });

  it("move on once a round has closed", () => {
    const sunday = new Date("2026-11-08T13:00:00Z");

    assert.equal(roundsNow({ series: "36TS" }, terms, sunday).current.date,
      "2026-11-22");
  });
});

describe("the tab's words (drafts)", () => {
  it("say how often, which day and when", () => {
    const r = { every: 2, opens: "08:30", closes: "09:00",
      current: { date: "2026-11-08" } };

    assert.equal(roundsLine(r), "Every 2 weeks, on Sundays, 8:30 to 9:00 AM");
    assert.equal(roundsLine({ ...r, every: 1 }).slice(0, 10), "Every week");
    assert.equal(hours("11:30", "12:30"), "11:30 AM to 12:30 PM");
    assert.equal(moment("2026-11-08T04:59:00.000Z", "America/New_York"),
      "Saturday, November 7, 11:59 PM");
  });

  it("say when and how each member joined", () => {
    const placed = () => "Nov 2, 2026";

    assert.equal(joinedLine({ joinedAt: "x", via: "qr" }, placed),
      "Joined Nov 2, 2026, by QR code");
    for (const way of ["code", "link", "qr", "walk-in", "farm", "host",
      "invite"]) {
      assert.ok(JOIN_WAYS[way], way);
    }
  });
});

describe("the tab and the menu entry", () => {
  it("start hidden, for main.js and session.js to show", async () => {
    const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
    const account = await read("layouts/account/single.html");
    const menu = await read("layouts/partials/header/account-menu.html");

    assert.match(account,
      /<a [^>]*data-tab="membership"[^>]*data-membership-only hidden>/);
    assert.match(account, /<section [^>]*data-membership-only[^>]*hidden>/);
    assert.match(menu, /<li data-account-membership hidden>/);
  });
});
