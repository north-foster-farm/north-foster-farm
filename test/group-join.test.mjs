// A group's join token and its sign-up page (#495, part 4): the QR
// code's link is a long random token apart from the typed code;
// replacing it retires the old one at once and leaves the code and the
// members; the page sends our own link, which signs in, joins and
// lands on Membership.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { handle as authHandle } from "../netlify/functions/auth.mjs";
import {
  RATE, SEND_RATE, TOO_MANY, handle as joinHandle,
} from "../netlify/functions/join.mjs";
import {
  LINKS_PER_WINDOW, createSession, requestLink,
} from "../netlify/functions/lib/auth.mjs";
import { joinLog } from "../netlify/functions/lib/group-log.mjs";
import {
  codeUrl, findGroupByCode, findGroupByToken, getGroupRecord, joinGroup,
  joinPath, joinQr, joinTokenOf, joinUrl, memberKeyOf, rotateJoinToken,
  setGroupCode,
} from "../netlify/functions/lib/groups.mjs";
import {
  ELSEWHERE, INVALID_LINK, JOINED_PATH,
} from "../netlify/functions/lib/join.mjs";
import {
  CONSENT_TYPES, consentLog, getCustomer, saveCustomer,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { JOIN_NEWS } from "../netlify/functions/lib/templates.mjs";

const now = new Date("2026-11-02T14:00:00Z");
const env = { URL: "https://x" };
const PAT = "pat@example.com";

const setup = async () => {
  const stores = testStores();

  await setGroupCode(stores, "vff", { code: "GYM-2026", now });

  return { stores, token: await joinTokenOf(stores, "vff", { now }) };
};

let address = 0;

const post = (path, body, { stores, headers = {}, mail, ip } = {}) =>
  joinHandle(new Request(`http://x${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), { stores, env, now, mail, ip: ip || `10.0.0.${(address += 1) % 250}` });

const outbox = () => {
  const sent = [];

  return { sent, mail: async (message) => { sent.push(message); } };
};

// The sign-in token in the emailed link, followed as a browser would.
const follow = async (stores, message) => {
  const token = /token=([A-Za-z0-9_-]+)/.exec(message.text)[1];

  return authHandle(new Request(`http://x/api/auth/verify?token=${token}`),
    { stores, env, now });
};

const signUp = (overrides = {}) => ({
  firstName: "Pat", lastName: "Example", email: PAT, news: false,
  ...overrides,
});

describe("the join token", () => {
  it("is long and random, apart from the code, and opens the group",
    async () => {
      const { stores, token } = await setup();

      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal((await findGroupByToken(stores, token)).key, "vff");
      assert.equal(await findGroupByCode(stores, token), null);
      assert.equal(await joinTokenOf(stores, "vff"), token, "kept");
      assert.equal(joinPath(token), `/join/?t=${token}`);
    });

  // The qa on #495 (6455105350, item 2): the CLI read URL, which the
  // .env files don't set, and printed a bare path a phone won't open.
  it("builds the printed link and the QR payload whole, from SITE_URL",
    async () => {
      const { token } = await setup();
      const drawn = [];
      const draw = (text, { title }) => {
        drawn.push({ text, title });

        return "<svg/>";
      };
      const site = { SITE_URL: "https://www.northfosterfarm.com/" };
      const { link, svg } = joinQr(token, "Valley Fitness", {
        env: site, draw,
      });

      assert.equal(link,
        `https://www.northfosterfarm.com/join/?t=${token}`);
      assert.equal(svg, "<svg/>");
      assert.deepEqual(drawn, [{ text: link, title: "Join Valley Fitness" }]);
      assert.equal(codeUrl("GYM-2026", site),
        "https://www.northfosterfarm.com/order/?group=GYM-2026");

      // With nothing set, still a whole address, never a bare path.
      for (const url of [joinQr(token, "G", { env: {}, draw }).link,
        joinUrl(token, {}), codeUrl("GYM-2026", {})]) {
        assert.match(url, /^https?:\/\/[^/]/);
      }
      assert.match(drawn.at(-1).text, /^https?:\/\/[^/]/);

      // `groups qr` and `groups show` print through these, not URL.
      const cli = readFileSync(new URL("../bin/nff", import.meta.url),
        "utf8");

      assert.ok(!cli.includes("process.env.URL"));
      assert.match(cli, /groups\.joinQr\(token, g\.name\)/);
      assert.match(cli, /groups\.codeUrl\(record\.code\)/);
    });

  it("retires the old QR code at once and keeps the code and members",
    async () => {
      const { stores, token } = await setup();

      await saveCustomer(stores, { email: PAT, name: "Pat" });
      await joinGroup(stores, PAT, "vff", { now, via: "code" });

      const next = (await rotateJoinToken(stores, "vff", { now })).joinToken;

      assert.notEqual(next, token);
      assert.equal(await findGroupByToken(stores, token), null);
      assert.equal((await findGroupByToken(stores, next)).key, "vff");
      assert.equal((await findGroupByCode(stores, "GYM-2026")).key, "vff");
      assert.equal(memberKeyOf(await getCustomer(stores, PAT)), "vff");

      const record = await getGroupRecord(stores, "vff");

      assert.equal(record.joinTokensRetired, 1);
      assert.ok(!JSON.stringify(record).includes(token), "the old one goes");
    });

  it("opens nothing for a token of the wrong shape", async () => {
    const { stores } = await setup();

    for (const t of ["", null, "short", "x".repeat(200), "GYM-2026"]) {
      assert.equal(await findGroupByToken(stores, t), null);
    }
  });
});

describe("POST /api/join/check", () => {
  it("names the group for a token in force, and nothing else", async () => {
    const { stores, token } = await setup();
    const good = await post("/api/join/check", { token }, { stores });

    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), {
      ok: true, group: { name: "The Village Family Fitness" },
      signedIn: false, already: false, elsewhere: false,
    });

    const bad = await post("/api/join/check", { token: "y".repeat(43) },
      { stores });

    assert.equal(bad.status, 404);
    assert.equal((await bad.json()).message, INVALID_LINK);
  });

  it("says when the one signed in is in already, or elsewhere",
    async () => {
      const { stores, token } = await setup();
      const session = await createSession(stores, PAT, { now });
      const headers = { cookie: `nff_session=${session.id}` };
      const ask = async () => (await post("/api/join/check", { token },
        { stores, headers })).json();

      assert.equal((await ask()).signedIn, true);

      await joinGroup(stores, PAT, "vff", { now, via: "code" });
      assert.equal((await ask()).already, true);

      const pat = await getCustomer(stores, PAT);

      await saveCustomer(stores, { ...pat, memberGroup: {
        id: "other", joinedAt: now.toISOString(), via: "code" } });
      assert.equal((await ask()).elsewhere, true);
    });

  it("holds back an address after too many dead tokens, saying what",
    async () => {
      const { stores, token } = await setup();
      const ip = "9.9.9.9";

      for (let i = 0; i < RATE.max; i++) {
        await post("/api/join/check", { token: "z".repeat(43) },
          { stores, ip });
      }

      const held = await post("/api/join/check", { token }, { stores, ip });

      assert.equal(held.status, 429);
      assert.equal((await held.json()).message, TOO_MANY);
      assert.match(TOO_MANY, /link to join a group/);
    });
});

describe("the sign-up form and its link", () => {
  it("sends our own link, which signs in, joins and lands on Membership",
    async () => {
      const { stores, token } = await setup();
      const { sent, mail } = outbox();
      const res = await post("/api/join/request", { token, ...signUp() },
        { stores, mail });

      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, PAT);
      assert.match(sent[0].subject, /^Join The Village Family Fitness/);
      assert.ok(!sent[0].text.includes(token), "the join token stays home");
      assert.equal(await getCustomer(stores, PAT), null,
        "nothing until the link is followed");

      const landed = await follow(stores, sent[0]);

      assert.equal(landed.status, 302);
      assert.equal(landed.headers.get("location"), JOINED_PATH);
      assert.match(landed.headers.get("set-cookie"), /nff_session=/);

      const pat = await getCustomer(stores, PAT);

      assert.equal(memberKeyOf(pat), "vff");
      assert.equal(pat.memberGroup.via, "qr");
      assert.equal(pat.firstName, "Pat");
      assert.equal(pat.lastName, "Example");
      assert.notEqual(pat.marketing, true, "Farm News was not ticked");
      assert.deepEqual((await joinLog(stores, "vff")).map((j) => j.via),
        ["qr"]);
    });

  // The coordinator's security review: anyone with the QR code can ask
  // for join links to an address, so they count in their own bucket
  // and never use up its owner's sign-in links.
  it("limits join links apart from sign-in links", async () => {
    const { stores, token } = await setup();
    const { sent, mail } = outbox();

    for (let i = 0; i < LINKS_PER_WINDOW + 2; i++) {
      const res = await post("/api/join/request", { token, ...signUp() },
        { stores, mail });

      assert.equal(res.status, 200, "the page says the same either way");
    }
    assert.equal(sent.length, LINKS_PER_WINDOW, "join links are limited");
    assert.ok(await stores.auth.get(`rate/join/${PAT}`));
    assert.equal(await stores.auth.get(`rate/${PAT}`), null);

    for (let i = 0; i < LINKS_PER_WINDOW; i++) {
      const signIn = await requestLink(stores,
        { email: PAT, next: "/account/" }, { now, env, mail });

      assert.equal(signIn.ok, true, "sign-in links still go");
    }
    assert.equal((await requestLink(stores,
      { email: PAT, next: "/account/" }, { now, env, mail })).reason, "rate");

    // And a spent sign-in bucket doesn't stop a join link either.
    await stores.auth.delete(`rate/join/${PAT}`);
    await post("/api/join/request", { token, ...signUp() }, { stores, mail });
    assert.equal(sent.length, 2 * LINKS_PER_WINDOW + 1);
  });

  // The qa on #495 (6455105350, item 5): anyone can type an address
  // and tick the box, so the email tells its owner, and the owner's
  // click is the consent.
  it("says Farm News in the email when ticked, and the click subscribes",
    async () => {
      const { stores, token } = await setup();
      const { sent, mail } = outbox();

      await post("/api/join/request", { token, ...signUp({ news: true }) },
        { stores, mail });

      assert.equal(sent.length, 1);
      assert.ok(sent[0].text.includes(JOIN_NEWS));
      assert.ok(sent[0].html.includes(JOIN_NEWS));
      assert.equal(await getCustomer(stores, PAT), null,
        "nothing subscribes before the owner follows the link");

      await follow(stores, sent[0]);

      const pat = await getCustomer(stores, PAT);
      const [event] = consentLog(pat);

      assert.equal(pat.marketing, true);
      assert.equal(pat.marketingSource, "join-link");
      assert.equal(consentLog(pat).length, 1);
      assert.equal(event.action, "in");
      assert.equal(event.type, "join-link");
      assert.match(event.detail, /group sign-up page/);
      assert.equal(event.at, now.toISOString());
      assert.ok(CONSENT_TYPES.includes("join-link"));
    });

  it("says nothing of Farm News when unticked, and nothing subscribes",
    async () => {
      const { stores, token } = await setup();
      const { sent, mail } = outbox();

      await post("/api/join/request", { token, ...signUp({ news: false }) },
        { stores, mail });

      assert.ok(!/Farm News/.test(sent[0].text));
      assert.ok(!/Farm News/.test(sent[0].html));

      await follow(stores, sent[0]);

      const pat = await getCustomer(stores, PAT);

      assert.equal(memberKeyOf(pat), "vff");
      assert.notEqual(pat.marketing, true);
      assert.deepEqual(consentLog(pat), []);
    });

  it("keeps the names an account already has", async () => {
    const { stores, token } = await setup();
    const { sent, mail } = outbox();

    await saveCustomer(stores, { email: PAT, firstName: "Patricia",
      lastName: "Owner", name: "Patricia Owner" });
    await post("/api/join/request", { token,
      ...signUp({ firstName: "Someone", lastName: "Else" }) },
    { stores, mail });
    await follow(stores, sent[0]);

    const pat = await getCustomer(stores, PAT);

    assert.equal(pat.firstName, "Patricia");
    assert.equal(memberKeyOf(pat), "vff");
  });

  it("joins nothing when the QR code was replaced before the link",
    async () => {
      const { stores, token } = await setup();
      const { sent, mail } = outbox();

      await post("/api/join/request", { token, ...signUp() },
        { stores, mail });
      await rotateJoinToken(stores, "vff", { now });

      const landed = await follow(stores, sent[0]);

      // The marker noCopy adds when the path has no query (lib/http).
      assert.equal(landed.headers.get("location"), "/account/?via=link");
      assert.equal(memberKeyOf(await getCustomer(stores, PAT)), null);
    });

  it("asks for the names and a valid email address", async () => {
    const { stores, token } = await setup();
    const { sent, mail } = outbox();
    const res = await post("/api/join/request", {
      token, firstName: " ", lastName: "", email: "nope",
    }, { stores, mail });

    assert.equal(res.status, 422);
    assert.deepEqual((await res.json()).errors, {
      email: "Please enter a valid email address.",
      firstName: "Please enter your first name.",
      lastName: "Please enter your last name.",
    });
    assert.equal(sent.length, 0);
  });

  it("sends no more than the limit from one address", async () => {
    const { stores, token } = await setup();
    const { sent, mail } = outbox();
    const ip = "8.8.8.8";

    for (let i = 0; i <= SEND_RATE.max; i++) {
      const res = await post("/api/join/request", {
        token, ...signUp({ email: `p${i}@example.com` }),
      }, { stores, mail, ip });

      assert.equal(res.status, 200);
    }
    assert.equal(sent.length, SEND_RATE.max);
  });

  it("refuses a dead token and sends nothing", async () => {
    const { stores } = await setup();
    const { sent, mail } = outbox();
    const res = await post("/api/join/request", {
      token: "q".repeat(43), ...signUp(),
    }, { stores, mail });

    assert.equal(res.status, 404);
    assert.equal(sent.length, 0);
  });
});

describe("POST /api/join, signed in", () => {
  it("joins at once with nothing to type", async () => {
    const { stores, token } = await setup();
    const session = await createSession(stores, PAT, { now });
    const res = await post("/api/join", { token }, {
      stores, headers: { cookie: `nff_session=${session.id}` },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, next: JOINED_PATH });
    assert.equal(memberKeyOf(await getCustomer(stores, PAT)), "vff");
  });

  it("needs a session, and never moves another group's member",
    async () => {
      const { stores, token } = await setup();

      assert.equal((await post("/api/join", { token }, { stores })).status,
        401);

      const session = await createSession(stores, PAT, { now });
      const pat = await getCustomer(stores, PAT);

      await saveCustomer(stores, { ...pat, memberGroup: {
        id: "other", joinedAt: now.toISOString(), via: "code" } });

      const res = await post("/api/join", { token }, {
        stores, headers: { cookie: `nff_session=${session.id}` },
      });

      assert.equal(res.status, 409);
      assert.equal((await res.json()).message, ELSEWHERE);
      assert.equal(memberKeyOf(await getCustomer(stores, PAT)), "other");
    });
});
