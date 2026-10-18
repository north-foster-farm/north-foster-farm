import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Decrypter, generateIdentity, identityToRecipient,
} from "age-encryption";

import { handle } from "../netlify/functions/backup.mjs";
import {
  countsOf, dump, exportBackup, nightly, objectKey, restore, sign,
} from "../netlify/functions/lib/backup.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const now = new Date("2026-10-16T07:00:00Z");

const keys = async () => {
  const identity = await generateIdentity();

  return { identity, recipient: await identityToRecipient(identity) };
};

const envFor = (recipient) => ({
  SITE_CONTEXT: "production",
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com", DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  BACKUP_AGE_RECIPIENT: recipient,
  BACKUP_R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com/",
  BACKUP_R2_BUCKET: "nff-backups",
  BACKUP_R2_ACCESS_KEY_ID: "AKID",
  BACKUP_R2_SECRET_ACCESS_KEY: "SECRET",
  HEALTHCHECKS_BACKUP_URL: "https://hc/backup",
  HEALTHCHECKS_ALERT_URL: "https://hc/alert",
});

// R2 answers `status`; every other host answers 200.
const fakeFetch = (status = 200) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", init });
    const code = /r2\./.test(url) ? status : 200;

    return { ok: code < 400, status: code, text: async () => "denied" };
  };

  return { calls, fetchImpl };
};

const mailbox = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

const seeded = async () => {
  const s = testStores();

  await s.orders.set("order/A1", { id: "A1", status: "paid" });
  await s.orders.set("by-email/a@x.com/A1", { id: "A1" });
  await s.customers.set("customer/a@x.com", { email: "a@x.com" });
  await s.customers.set("customer/b@x.com",
    { email: "b@x.com", marketing: true });
  await s.stock.set("counts", { egg: 3 });

  return s;
};

describe("the backup export", () => {
  it("dumps the orders and customers stores, and counts them", async () => {
    const backup = await dump(await seeded(),
      { env: { SITE_CONTEXT: "production" }, now });

    assert.equal(backup.context, "production");
    assert.deepEqual(Object.keys(backup.stores), ["orders", "customers"]);
    assert.deepEqual(backup.counts, {
      keys: { orders: 2, customers: 2 },
      orders: 1, customers: 2, subscribers: 1,
    });
  });

  it("encrypts to the recipient and puts it in the bucket", async () => {
    const { identity, recipient } = await keys();
    const { calls, fetchImpl } = fakeFetch();
    const r = await exportBackup(await seeded(),
      { env: envFor(recipient), fetchImpl, now });

    assert.equal(r.key, "production/2026-10-16T07-00-00Z-nightly.json.age");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://acct.r2.cloudflarestorage.com/" +
      "nff-backups/production/2026-10-16T07-00-00Z-nightly.json.age");
    assert.equal(calls[0].method, "PUT");
    assert.match(calls[0].init.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261016\/auto\/s3\/aws4_request, /);

    const body = calls[0].init.body;

    assert.ok(!Buffer.from(body).toString().includes("a@x.com"),
      "nothing readable leaves");

    const d = new Decrypter();

    d.addIdentity(identity);
    const back = JSON.parse(await d.decrypt(body, "text"));

    assert.equal(back.stores.orders[0].key, "by-email/a@x.com/A1");
    assert.deepEqual(back.counts, r.counts);
  });

  it("names what is unset before it reads anything", async () => {
    await assert.rejects(exportBackup(testStores(),
      { env: { BACKUP_AGE_RECIPIENT: "age1x" } }),
    new RegExp("BACKUP_R2_ENDPOINT, BACKUP_R2_BUCKET, " +
      "BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY unset"));
  });

  it("keeps a key unique to the second", () => {
    assert.equal(objectKey("branch-deploy", "before-release", now),
      "branch-deploy/2026-10-16T07-00-00Z-before-release.json.age");
  });
});

describe("the nightly run", () => {
  it("does nothing where nothing is configured", async () => {
    const { calls, fetchImpl } = fakeFetch();

    assert.deepEqual(await nightly(testStores(), { env: {}, fetchImpl }),
      { skipped: true });
    assert.equal(calls.length, 0);
  });

  it("pings the check when the copy lands", async () => {
    const { recipient } = await keys();
    const { calls, fetchImpl } = fakeFetch();
    const res = await handle({
      s: await seeded(), env: envFor(recipient), fetchImpl, now,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(calls.slice(1).map((c) => [c.url, c.method]),
      [["https://hc/backup", "POST"]]);
  });

  it("alerts backup.failed and fails the check when R2 refuses",
    async () => {
      const { recipient } = await keys();
      const { calls, fetchImpl } = fakeFetch(403);
      const { sent, mail } = mailbox();
      const res = await handle({
        s: await seeded(), env: envFor(recipient), fetchImpl, mail, now,
      });

      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /R2 answered 403: denied/);
      assert.deepEqual(sent.map((m) => m.subject),
        ["Site alert: backup.failed"]);
      assert.ok(calls.some((c) => c.url === "https://hc/backup/fail"));
    });
});

describe("the restore", () => {
  it("writes every record into empty stores and counts them back",
    async () => {
      const backup = await dump(await seeded(), { now });
      const r = await restore(testStores(), JSON.parse(
        JSON.stringify(backup)));

      assert.deepEqual(r.found, r.expected);
      assert.deepEqual(r.expected, countsOf(backup));
    });

  it("refuses stores that hold anything", async () => {
    const backup = await dump(await seeded(), { now });

    await assert.rejects(restore(await seeded(), backup), /not empty/);
    await assert.rejects(restore(testStores(), { stores: {} }),
      /Not an nff backup/);
  });
});

describe("the S3 signature", () => {
  // AWS's own worked example: "GET Object" in Signature Version 4,
  // "Authenticating Requests (AWS Signature Version 4)", S3 docs.
  it("matches AWS's published example", () => {
    const h = sign({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb924" +
        "27ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      now: new Date("2013-05-24T00:00:00Z"),
    });

    assert.equal(h.authorization, "AWS4-HMAC-SHA256 " +
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed31" +
      "0bd44f0170aba48dd91039c6036bdb41");
  });
});
