import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import { endAllSessions } from "../netlify/functions/lib/admin.mjs";
import {
  COOKIE, createSession, endSession, requestLink, sessionFrom, verifyToken,
} from "../netlify/functions/lib/auth.mjs";
import {
  AUTH_PREFIXES, INDEX, INDEX_GRACE, authRecordsFor, backfillIndex, deleteAuth,
  indexKey, namedBy, pruneIndex, putAuth, staleIndexKey,
} from "../netlify/functions/lib/auth-records.mjs";
import { maskEmail } from "../netlify/functions/lib/mask.mjs";
import {
  confirmSubscribe, requestSubscribe, unsubscribeLinks,
} from "../netlify/functions/lib/news.mjs";
import { sweepAuth } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-29T13:00:00Z");
const env = { URL: "https://northfosterfarm.com" };
const PAT = "pat@example.com";
const SAM = "sam@example.com";
const quiet = { now, env, send: false, limit: false };

const keysUnder = async (stores, prefix) =>
  (await stores.auth.list(prefix)).map(({ key }) => key);

// Every record with an index key under each address it names, and no
// index key without its record: the index in step with the store.
const assertInStep = async (stores) => {
  for (const prefix of AUTH_PREFIXES) {
    for (const key of await keysUnder(stores, prefix)) {
      for (const email of namedBy(await stores.auth.get(key))) {
        assert.ok(await stores.auth.get(indexKey(email, key)),
          `${key} has no index key for one of its addresses`);
      }
    }
  }
  for (const key of await keysUnder(stores, INDEX)) {
    assert.equal(await staleIndexKey(stores, key), false,
      `${key} outlived its record`);
  }
};

const token = (url) => new URL(url).searchParams.get("token");
const withCookie = (id) => new Request(`${env.URL}/api/me`, {
  headers: { cookie: `${COOKIE}=${id}` },
});

describe("the auth records' index (#508)", () => {
  it("is written before a record and deleted after it", async () => {
    const stores = testStores();

    await putAuth(stores, "token/t1", { email: PAT, changeFrom: SAM });
    assert.deepEqual(await keysUnder(stores, INDEX),
      [indexKey(PAT, "token/t1"), indexKey(SAM, "token/t1")].sort());
    assert.deepEqual((await authRecordsFor(stores, SAM)).map((r) => r.key),
      ["token/t1"]);

    await deleteAuth(stores, "token/t1");
    assert.deepEqual(await keysUnder(stores, ""), []);
  });

  it("follows a record to a new address", async () => {
    const stores = testStores();
    const before = { email: PAT };

    await putAuth(stores, "unsub/u1", before);
    await putAuth(stores, "unsub/u1", { email: SAM }, { before });

    assert.deepEqual(await authRecordsFor(stores, PAT), []);
    assert.deepEqual(await authRecordsFor(stores, SAM),
      [{ key: "unsub/u1", value: { email: SAM } }]);
    await assertInStep(stores);
  });

  it("skips an index key its record no longer backs", async () => {
    const stores = testStores();

    await putAuth(stores, "session/s1", { email: PAT });
    await stores.auth.set(indexKey(PAT, "session/gone"), {});
    await stores.auth.set(indexKey(PAT, "session/moved"), {});
    await stores.auth.set("session/moved", { email: SAM });

    assert.deepEqual((await authRecordsFor(stores, PAT)).map((r) => r.key),
      ["session/s1"]);
    assert.equal(await staleIndexKey(stores,
      indexKey(PAT, "session/gone")), true);
    assert.equal(await staleIndexKey(stores,
      indexKey(PAT, "session/moved")), true);
    assert.equal(await staleIndexKey(stores,
      indexKey(PAT, "session/s1")), false);
  });

  it("is kept by every writer of a link or a session", async () => {
    const stores = testStores();

    await requestLink(stores, { email: PAT }, quiet);
    await requestLink(stores, { email: SAM }, { ...quiet, changeFrom: PAT });
    await createSession(stores, PAT, { now });
    await unsubscribeLinks(stores, PAT, { env, now });
    await requestSubscribe(stores, { email: PAT }, quiet);

    const mine = await authRecordsFor(stores, PAT);

    assert.deepEqual(mine.map((r) => r.key.split("/")[0]).sort(),
      ["news", "session", "token", "token", "unsub"]);
    await assertInStep(stores);
  });

  it("is kept by every reader that spends or ends one", async () => {
    const stores = testStores();
    const link = await requestLink(stores, { email: PAT }, quiet);
    const news = await requestSubscribe(stores, { email: PAT }, quiet);
    const ended = await createSession(stores, PAT, { now });
    const lapsed = await createSession(stores, PAT, { now });
    const later = new Date(now.getTime() + 400 * 24 * 3600_000);

    await verifyToken(stores, token(link.url), { now });
    await confirmSubscribe(stores, token(news.url), {
      now, env, mail: async () => ({}),
    });
    await endSession(stores, ended.id);
    assert.equal(await sessionFrom(stores, withCookie(lapsed.id), {
      now: later,
    }), null);

    // The confirmed sign-up's welcome brings an unsubscribe link.
    assert.deepEqual((await authRecordsFor(stores, PAT))
      .map((r) => r.key.split("/")[0]), ["unsub"]);
    assert.equal((await keysUnder(stores, INDEX)).length, 1);
    await assertInStep(stores);
  });

  it("is kept by the sweep, which also clears what a write left", async () => {
    const stores = testStores();
    const later = new Date(now.getTime() + 400 * 24 * 3600_000);

    await requestLink(stores, { email: PAT }, quiet);
    await createSession(stores, PAT, { now });
    await putAuth(stores, "session/rawid", { email: PAT, expires: 0 });
    await stores.auth.set(indexKey(SAM, "token/gone"), {});

    assert.equal(await sweepAuth(stores, later), 3);
    assert.deepEqual(await keysUnder(stores, INDEX), []);
  });

  it("stores when each index key was written", async () => {
    const stores = testStores();
    const start = Date.now();

    await putAuth(stores, "token/t1", { email: PAT });

    const { at } = await stores.auth.get(indexKey(PAT, "token/t1"));

    assert.ok(at >= start && at <= Date.now(), `at ${at}`);
  });

  // The sweep can list an index key putAuth has just written and read
  // its record before putAuth writes it. A young key is left for later.
  it("is pruned only once a stale key is 10 minutes old", async () => {
    const stores = testStores();
    const at = Date.now();

    await stores.auth.set(indexKey(PAT, "token/young"), { at });
    await stores.auth.set(indexKey(PAT, "token/old"), {
      at: at - INDEX_GRACE,
    });
    await stores.auth.set(indexKey(PAT, "token/before"), {});
    await putAuth(stores, "token/live", { email: PAT });

    assert.equal(await pruneIndex(stores, { now: at }), 2);
    assert.deepEqual(await keysUnder(stores, INDEX),
      [indexKey(PAT, "token/live"), indexKey(PAT, "token/young")].sort());

    // The record lands, and the young key is its index.
    await stores.auth.set("token/young", { email: PAT });
    assert.equal(await pruneIndex(stores, {
      now: at + INDEX_GRACE + 1,
    }), 0);
    await assertInStep(stores);
  });

  it("is pruned in batches past the first", async () => {
    const stores = testStores();

    for (let i = 0; i < 60; i += 1) {
      await stores.auth.set(indexKey(PAT, `token/gone${i}`), {});
    }
    assert.equal(await pruneIndex(stores), 60);
    assert.deepEqual(await keysUnder(stores, INDEX), []);
  });

  it("is kept when every session ends", async () => {
    const stores = testStores();

    await createSession(stores, PAT, { now });
    await createSession(stores, SAM, { now });
    await endAllSessions(stores, { apply: true, env: {}, now });

    assert.deepEqual(await keysUnder(stores, INDEX), []);
  });
});

describe("auth backfill-index (#508)", () => {
  const SESSION = `session/${"a".repeat(64)}`;

  // Records as the code before the index wrote them, and a session from
  // before sessions were stored under a hash of the id.
  const seed = async () => {
    const stores = testStores();

    await stores.auth.set(SESSION, { email: PAT, expires: 1 });
    await stores.auth.set("session/rawid", { email: PAT, expires: 1 });
    await stores.auth.set("token/t1", {
      email: SAM, changeFrom: PAT, expires: 1,
    });
    await stores.auth.set("unsub/u1", { email: "Pat@Example.com" });
    await putAuth(stores, "news/n1", { email: SAM });
    await stores.auth.set(`rate/${PAT}`, { times: [1] });

    return stores;
  };
  const capture = (t) => {
    const lines = [];

    for (const level of ["log", "info", "warn", "error"]) {
      t.mock.method(console, level, (...args) => {
        lines.push(args.map(String).join(" "));
      });
    }

    return lines;
  };

  it("only reports by default", async (t) => {
    const stores = await seed();
    const lines = capture(t);
    const before = await keysUnder(stores, "");

    assert.deepEqual(await backfillIndex(stores), {
      apply: false, records: 4, skipped: 1, missing: 4, written: 0,
    });
    assert.deepEqual(await keysUnder(stores, ""), before);
    assert.deepEqual(lines, []);
  });

  it("with apply, indexes every record and logs each key", async (t) => {
    const stores = await seed();
    const lines = capture(t);

    assert.deepEqual(await backfillIndex(stores, {
      apply: true, by: "james",
    }), { apply: true, records: 4, skipped: 1, missing: 4, written: 4 });
    assert.deepEqual((await authRecordsFor(stores, PAT)).map((r) => r.key),
      [SESSION, "token/t1", "unsub/u1"]);

    const logged = lines.map((l) => JSON.parse(l))
      .filter((l) => l.event === "auth.index_backfilled");

    assert.equal(logged.length, 4);
    assert.deepEqual(logged[0], {
      _time: logged[0]._time, level: "info",
      event: "auth.index_backfilled", by: "james", prefix: "session",
      record: maskEmail(PAT), before: "absent", after: "present",
    });
    assert.deepEqual(logged.map((l) => l.prefix),
      ["session", "token", "token", "unsub"]);
    assert.ok(lines.every((l) => !l.includes(PAT) && !l.includes(SAM)));

    assert.deepEqual(await backfillIndex(stores, { apply: true }), {
      apply: true, records: 4, skipped: 1, missing: 0, written: 0,
    });
  });

  // A record's key is the hash of its secret, and a raw-id session's
  // key is the secret itself: neither reaches a log.
  it("never logs a record's key", async (t) => {
    const stores = await seed();
    const lines = capture(t);
    const keys = (await keysUnder(stores, "")).filter((key) =>
      AUTH_PREFIXES.some((p) => key.startsWith(p)));

    await backfillIndex(stores, { apply: true, by: "james" });
    assert.equal(lines.length, 5);
    for (const key of keys) {
      const [, secret] = key.split("/");

      assert.ok(lines.every((l) => !l.includes(secret)), `${key} logged`);
    }
  });

  it("leaves a session under a raw id for the sweep", async () => {
    const stores = await seed();

    await backfillIndex(stores, { apply: true });
    assert.equal(await stores.auth.get(indexKey(PAT, "session/rawid")), null);
    assert.ok(await stores.auth.get("session/rawid"));

    await sweepAuth(stores, now);
    assert.equal(await stores.auth.get("session/rawid"), null);
    await assertInStep(stores);
  });
});

// A record written or deleted past putAuth and deleteAuth has no index
// key, and a rename or a deletion would miss it. Every other write to
// the auth store must be to a key that is not a sign-in record: the
// rate limits, named here by their call.
describe("the writers of the auth store (#508)", () => {
  const root = join(import.meta.dirname, "..");
  const OWN = "netlify/functions/lib/auth-records.mjs";
  const NOT_RECORDS = new Set([
    // The hit() counter: rate/, change-rate/ and change-ip/ keys.
    "netlify/functions/lib/auth.mjs: key",
    // The withinRate() counter: rate/news/<email>.
    "netlify/functions/lib/news.mjs: rateKey",
  ]);
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) return files(path);

    return /\.m?js$/.test(name) || !name.includes(".") ? [path] : [];
  });
  const sources = ["netlify", "bin"].flatMap((dir) => files(join(root, dir)))
    .map((path) => relative(root, path))
    .filter((path) => path !== OWN);
  const WRITE = /\bauth\.(set|delete|create|swap)\(\s*([^,)]+)/g;
  const RATE = /^`(rate|change-rate|change-ip)\//;

  it("go through putAuth and deleteAuth for a sign-in record", () => {
    const strays = [];

    for (const path of sources) {
      const text = readFileSync(join(root, path), "utf8");

      for (const [, , first] of text.matchAll(WRITE)) {
        const arg = first.trim();

        if (!RATE.test(arg) && !NOT_RECORDS.has(`${path}: ${arg}`)) {
          strays.push(`${path}: ${arg}`);
        }
      }
    }
    assert.deepEqual(strays, []);
  });
});
