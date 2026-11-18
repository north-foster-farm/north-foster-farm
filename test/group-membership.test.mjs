// The Membership tab (#495, part 5): a member sees the group's name,
// place and rounds; the host also gets the QR code, the short link it
// holds (#589) and the member list; anyone else gets nothing, and the
// tab and the menu entry show for neither.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import { handle as authHandle } from "../netlify/functions/auth.mjs";
import { handle } from "../netlify/functions/membership.mjs";
import { createSession } from "../netlify/functions/lib/auth.mjs";
import { auditLog } from "../netlify/functions/lib/group-log.mjs";
import {
  GROUPS, findGroupByToken, getGroupRecord, joinGroup, joinTokenOf, joinUrl,
  memberKeyOf, setGroupCode, setGroupHost, shortUrl,
} from "../netlify/functions/lib/groups.mjs";
import { roleOf, roundsNow } from "../netlify/functions/lib/membership.mjs";
import { qrSvg } from "../netlify/functions/lib/qr.mjs";
import {
  getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import {
  JOIN_WAYS, LINK_COPIED, LINK_NOT_COPIED, hours, joinedLine,
  moment, pickupMoment, placeLines, roundGroups, roundRows, roundsLine,
} from "../assets/scripts/account/lib/membership.mjs";
import {
  tabsBack, tabsBackStop, tabsMore, tabsStop,
} from "../assets/scripts/account/lib/tab-scroll.mjs";

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
      ["/api/membership/remove", "POST", { group: "vff", email: PAT }],
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
      assert.equal(view.member.rounds.current.date, "2026-11-22");
      assert.equal(view.member.members, undefined);
      assert.equal(view.member.qr, undefined);
      assert.deepEqual(view.hosts, []);

      assert.equal((await call(stores, "/api/membership/qr?group=vff",
        { headers: member })).status, 404);
      assert.equal((await call(stores, "/api/membership/remove", {
        method: "POST", headers: member, body: { group: "vff", email: HOST },
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

  // #589: the downloaded code holds the short link. The drawing is
  // the same for the same text (test/qr.test.mjs), so the download
  // matching the short link's drawing, and not the long link's, is
  // the code decoding to the short link.
  it("draws the short link into the downloaded QR code", async () => {
    const { stores, host } = await setup();
    const token = await joinTokenOf(stores, "vff", { now });
    const saved = await (await call(stores,
      "/api/membership/qr?group=vff&download=1", { headers: host })).text();
    const title = `Join ${GROUPS[0].name}`;

    assert.equal(saved, qrSvg("https://x/vff", { title }));
    assert.notEqual(saved, qrSvg(joinUrl(token, env), { title }));
    assert.ok(!saved.includes(token));
  });

  // #589: the pane hands out nothing it could ever need to take back.
  it("has no replacement for the host: no route, no log", async () => {
    const { stores, host } = await setup();
    const old = await joinTokenOf(stores, "vff", { now });

    for (const body of [{ group: "vff", rotate: true }, { group: "vff" }]) {
      const res = await call(stores, "/api/membership/qr", {
        method: "POST", headers: host, body,
      });

      assert.equal(res.status, 404, JSON.stringify(body));
    }
    assert.equal((await findGroupByToken(stores, old)).key, "vff");
    assert.deepEqual(await auditLog(stores, "vff"), []);
  });

  // #579, #589: the join link beside the code is the short link, and
  // no token is anywhere in the host's answer.
  it("gives the host the short link the QR code holds", async () => {
    const { stores, host } = await setup();
    const token = await joinTokenOf(stores, "vff", { now });
    const res = await call(stores, "/api/membership", { headers: host });
    const body = await res.text();
    const view = JSON.parse(body);

    assert.deepEqual(view.hosts[0].qr, { link: shortUrl("vff", env) });
    assert.equal(view.hosts[0].qr.link, "https://x/vff");
    assert.ok(!body.includes(token), "no token");
    assert.doesNotMatch(body, /\/join\//);
  });

  it("never gives a member the join link", async () => {
    const { stores, member } = await setup();
    const token = await joinTokenOf(stores, "vff", { now });
    const res = await call(stores, "/api/membership", { headers: member });
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.ok(!body.includes(token), "no token");
    assert.doesNotMatch(body, /\/join\//);
    assert.deepEqual(JSON.parse(body).hosts, []);
  });

  it("writes nothing for the link or the code: the short link mints",
    async () => {
      const { stores, host } = await setup();
      const view = await (await call(stores, "/api/membership",
        { headers: host })).json();

      assert.deepEqual(view.hosts[0].qr, { link: "https://x/vff" });
      assert.equal((await call(stores, "/api/membership/qr?group=vff",
        { headers: host })).status, 200);
      assert.ok(!(await getGroupRecord(stores, "vff")).joinToken);
    });

  // The coordinator's security review: same-site lets a sibling
  // (a deploy preview, a branch subdomain) act as the host. The
  // host's one change left is Remove (#589: the rotation is gone).
  it("refuses a host's change cross-site, or same-site but not same-origin",
    async () => {
      const { stores, host } = await setup();
      const remove = (headers) => call(stores, "/api/membership/remove", {
        method: "POST", body: { group: "vff", email: PAT },
        headers: { ...host, ...headers },
      });

      for (const headers of [
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
        { "sec-fetch-site": "none" },
        { "sec-fetch-site": "", origin: "http://preview.x" },
        { "sec-fetch-site": "" },
      ]) {
        assert.equal((await remove(headers)).status, 403,
          JSON.stringify(headers));
      }
      assert.equal(memberKeyOf(await getCustomer(stores, PAT)), "vff");
      assert.deepEqual(await auditLog(stores, "vff"), []);

      // A browser with no Sec-Fetch-Site but this Origin is let in.
      assert.equal((await remove({ "sec-fetch-site": "", origin: "http://x" }))
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
      const remove = (body) => call(stores, "/api/membership/remove",
        { method: "POST", headers: member, body });

      // The group they belong to, none named, or one they don't host.
      for (const group of ["vff", undefined, "nope"]) {
        assert.equal((await call(stores,
          `/api/membership/qr?group=${group || ""}`, { headers: member }))
          .status, 404, String(group));
      }
      assert.equal((await remove({ group: "vff", email: HOST })).status, 404);
      assert.equal((await remove({ email: HOST })).status, 404);
      assert.equal((await findGroupByToken(stores, vff)).key, "vff");
      assert.equal(memberKeyOf(await getCustomer(stores, HOST)), "vff");
      assert.deepEqual(await auditLog(stores, "vff"), []);

      // The one they host, its code holding its own short link.
      assert.equal(await (await call(stores, "/api/membership/qr?group=gym2",
        { headers: member })).text(),
      qrSvg("https://x/gym2", { title: "Join Second Gym" }));

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
      date: "2026-11-22", closesAt: "2026-11-22T04:59:00.000Z",
    });
    assert.deepEqual(r.next, {
      date: "2026-12-06", opensAt: "2026-11-22T04:59:00.000Z",
    });
  });

  it("move on once a round has closed", () => {
    const sunday = new Date("2026-11-22T13:00:00Z");

    assert.equal(roundsNow({ series: "36TS" }, terms, sunday).current.date,
      "2026-12-06");
  });
});

describe("the tab's words (drafts)", () => {
  it("say how often, which day and when", () => {
    const r = { every: 2, opens: "08:30", closes: "09:00",
      current: { date: "2026-11-22" } };

    // A time and its AM or PM are joined by a no-break space (#593).
    assert.equal(roundsLine(r),
      "Every 2 weeks, on Sundays, 8:30 to 9:00\u00a0AM");
    assert.equal(roundsLine({ ...r, every: 1 }).slice(0, 10), "Every week");
    assert.equal(hours("11:30", "12:30"), "11:30\u00a0AM to 12:30\u00a0PM");
    assert.equal(moment("2026-11-22T04:59:00.000Z", "America/New_York"),
      "Saturday, November 21, 11:59\u00a0PM");
  });

  // #579: four rows, James's labels, the pickups at the window's start.
  it("give the four round rows from the group's data", () => {
    const r = roundsNow({ series: "36TS" }, terms, now);

    assert.deepEqual(roundRows(r, "America/New_York"), {
      closes: "Saturday, November 21, 11:59\u00a0PM",
      pickup: "Sunday, November 22, 8:30\u00a0AM",
      opens: "Saturday, November 21, 11:59\u00a0PM",
      "next-pickup": "Sunday, December 6, 8:30\u00a0AM",
    });
  });

  it("leave out the rows the data can't fill", () => {
    const r = { every: 2, opens: null, closes: null,
      current: { date: "2026-11-22", closesAt: "2026-11-22T04:59:00.000Z" },
      next: null };

    assert.deepEqual(roundRows(r, "America/New_York"), {
      closes: "Saturday, November 21, 11:59\u00a0PM",
      pickup: "Sunday, November 22",
      opens: "",
      "next-pickup": "",
    });
    assert.deepEqual(roundRows(null, "America/New_York"), {
      closes: "", pickup: "", opens: "", "next-pickup": "",
    });
    assert.equal(pickupMoment("2026-11-22", "13:05"),
      "Sunday, November 22, 1:05\u00a0PM");
  });

  // #597: the rows under This round and Next round, in order.
  it("group the round rows under this round and the next", () => {
    const r = roundsNow({ series: "36TS" }, terms, now);

    assert.deepEqual(roundGroups(r, "America/New_York"), {
      this: [
        ["closes", "Saturday, November 21, 11:59\u00a0PM"],
        ["pickup", "Sunday, November 22, 8:30\u00a0AM"],
      ],
      next: [
        ["opens", "Saturday, November 21, 11:59\u00a0PM"],
        ["next-pickup", "Sunday, December 6, 8:30\u00a0AM"],
      ],
    });
  });

  it("leave out a round with no rows, and the rows it lacks", () => {
    const r = { every: 2, opens: null, closes: null,
      current: { date: "2026-11-22", closesAt: "2026-11-22T04:59:00.000Z" },
      next: null };

    assert.deepEqual(roundGroups(r, "America/New_York"), {
      this: [
        ["closes", "Saturday, November 21, 11:59\u00a0PM"],
        ["pickup", "Sunday, November 22"],
      ],
    });
    assert.deepEqual(roundGroups(null, "America/New_York"), {});
  });

  // #579: the join link's Copy, house rules (#400): no semicolons or
  // em dashes, the label fragment unpunctuated.
  it("say what Copy did", () => {
    assert.equal(LINK_COPIED, "Link copied");
    assert.equal(LINK_NOT_COPIED,
      "Copying failed. The link is selected, so copy it yourself.");
    for (const line of [LINK_COPIED, LINK_NOT_COPIED]) {
      assert.doesNotMatch(line, /[;—]/, line);
    }
  });

  it("put the pickup place on three lines", () => {
    assert.deepEqual(placeLines({ name: "The Gym", street: "1 Main St",
      city: "Foster", state: "RI", zip: "02825" }),
    ["The Gym", "1 Main St", "Foster, RI 02825"]);
    assert.deepEqual(placeLines(null), []);
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

  it("read as James wrote them (#579)", async () => {
    const account = await readFile(
      new URL("../layouts/account/single.html", import.meta.url), "utf8"
    );

    assert.ok(account.includes("<p>Add members to this group by sharing " +
      "the QR code or the link.</p>"));
    assert.doesNotMatch(account, /To add members/);
    // #589: no replacement in the pane, nor its panel or status.
    assert.doesNotMatch(account, /Generate (a )?new QR code/);
    for (const part of ["qr-new", "qr-confirm", "rotate", "qr-keep",
      "qr-status"]) {
      assert.ok(!account.includes(`"data-mem" "${part}"`), part);
      assert.ok(!account.includes(`data-mem="${part}"`), part);
    }
    // #597: James's subheadings, real headings under the group's h2,
    // each over its rows with the short labels (drafts).
    const round = (name) => account.match(new RegExp(
      `data-mem-round="${name}">([\\s\\S]*?)</div>`
    ))[1];

    assert.match(round("this"), /<h3 [^>]*>This round<\/h3>/);
    assert.match(round("this"), /data-mem-row="closes">Closes<\/dt>/);
    assert.match(round("this"), /data-mem-row="pickup">Pickup<\/dt>/);
    assert.match(round("next"), /<h3 [^>]*>Next round<\/h3>/);
    assert.match(round("next"), /data-mem-row="opens">Opens<\/dt>/);
    assert.match(round("next"), /data-mem-row="next-pickup">Pickup<\/dt>/);
    assert.doesNotMatch(account, /(This|Next) round (closes|opens|pickup)/);
    // Rounds has a row hook too, so a group with none drops it.
    assert.match(account, /data-mem-row="every">Rounds<\/dt>/);
    assert.doesNotMatch(account, /People who scan this code/);
  });
});

// #579: the account's tab row at 393 px, on the cart's pattern.
describe("the tab row's arrow", () => {
  // Six tabs of 80px in a 200px row: 280px of scroll.
  const tabs = Array.from({ length: 6 }, (_, i) => ({
    left: i * 80, right: i * 80 + 80,
  }));
  const view = (left) => ({ left, width: 200, full: 480 });

  it("shows while any tab lies past the row's end", () => {
    assert.equal(tabsMore(view(0)), true);
    assert.equal(tabsMore(view(278.5)), true);
  });

  it("goes when the row fits or is scrolled to its end", () => {
    assert.equal(tabsMore(view(280)), false);
    // A pixel's allowance for a fractional rest.
    assert.equal(tabsMore(view(279.2)), false);
    assert.equal(tabsMore({ left: 0, width: 480, full: 480 }), false);
  });

  it("brings the first tab cut off to the row's start, never past the end",
    () => {
      assert.equal(tabsStop(tabs, view(0)), 160);
      assert.equal(tabsStop(tabs, view(160)), 280);
    });
});

// #591: the same arrow at the row's start.
describe("the tab row's start arrow", () => {
  const tabs = Array.from({ length: 6 }, (_, i) => ({
    left: i * 80, right: i * 80 + 80,
  }));
  const view = (left) => ({ left, width: 200, full: 480 });

  it("shows while any tab lies before the row's start", () => {
    assert.equal(tabsBack(view(280)), true);
    assert.equal(tabsBack(view(1.5)), true);
  });

  it("goes when the row fits or is at its start", () => {
    assert.equal(tabsBack(view(0)), false);
    // The end's pixel of allowance.
    assert.equal(tabsBack(view(0.8)), false);
    assert.equal(tabsBack({ left: 0, width: 480, full: 480 }), false);
  });

  it("shows with the end's arrow mid-row", () => {
    assert.equal(tabsBack(view(120)), true);
    assert.equal(tabsMore(view(120)), true);
  });

  it("brings the last tab cut off at the start to the row's end", () => {
    // At the end, the fourth tab (240-320) is cut off: its right end
    // meets the row's end.
    assert.equal(tabsBackStop(tabs, view(280)), 120);
    // Mid-tab: the tab under the start (80-160) comes whole.
    assert.equal(tabsBackStop(tabs, view(120)), 0);
    // A fractional rest doesn't count as a tab cut off: half a pixel
    // into the fourth tab (240-320), the third (160-240) is the one
    // brought to the end. Without the allowance it would be the
    // fourth, at 120.
    assert.equal(tabsBackStop(tabs, view(240.5)), 40);
  });

  it("starts a tab wider than the row at the row's start", () => {
    const wide = [{ left: 0, right: 80 }, { left: 80, right: 400 }];

    assert.equal(
      tabsBackStop(wide, { left: 300, width: 200, full: 400 }), 80
    );
  });

  it("never goes past the start", () => {
    assert.equal(tabsBackStop(tabs, view(0)), 0);
    assert.equal(tabsBackStop([], view(100)), 0);
  });
});

// #591: each end's fade, its arrow on it, 30px here. A stop brings the
// tab clear of both fades, so neither arrow lands on its letters.
describe("the tab row's stops, clear of the fades", () => {
  const tabs = Array.from({ length: 6 }, (_, i) => ({
    left: i * 80, right: i * 80 + 80,
  }));
  const view = (left) => ({ left, width: 200, full: 480 });
  const clear = (t, left) => (left <= 1 || t.left >= left + 30)
    && (left >= 280 || t.right <= left + 200 - 30);

  it("the end's arrow starts the tab cut off past the start's fade", () => {
    // From the start, the third tab (160-240) is cut off: it starts
    // 30px in, not under the start's arrow. Without the fade, 160.
    assert.equal(tabsStop(tabs, view(0), 30), 130);
    assert.ok(clear(tabs[2], 130));
    // A tab whole but under the end's fade counts as cut off: at 130
    // the row ends at 330, and the fourth tab (240-320) lies under the
    // fade (300-330), so it is the next.
    assert.equal(tabsStop(tabs, view(130), 30), 210);
    assert.ok(clear(tabs[3], 210));
  });

  it("the start's arrow ends the tab cut off before the end's fade",
    () => {
      // At the end, the fourth tab (240-320) lies under the start's
      // fade (280-310): its right end comes 30px short of the row's.
      assert.equal(tabsBackStop(tabs, view(280), 30), 150);
      assert.ok(clear(tabs[3], 150));
      // Whole but under the fade still counts: at 150 the third tab
      // (160-240) lies under the start's fade (150-180), so it is the
      // one, its end clear of the end's fade. Without the fade, 0.
      assert.equal(tabsBackStop(tabs, view(150), 30), 70);
      assert.ok(clear(tabs[2], 70));
      assert.equal(tabsBackStop(tabs, view(150)), 0);
    });

  it("moves a tab too wide for the room between the fades on", () => {
    const wide = [{ left: 0, right: 80 }, { left: 80, right: 400 }];
    const row = { width: 200, full: 400 };

    assert.equal(tabsStop(wide, { ...row, left: 60 }, 30), 200);
    assert.equal(tabsBackStop(wide, { ...row, left: 200 }, 30), 50);
  });

  it("never passes either end", () => {
    assert.equal(tabsStop(tabs, view(250), 30), 280);
    assert.equal(tabsBackStop(tabs, view(40), 30), 0);
  });
});
