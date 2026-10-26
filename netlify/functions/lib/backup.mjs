// The backup export (#267, D-EXPORT). Every record in the orders and
// customers stores (subscribers are customer records with
// `marketing`), as one JSON document, encrypted with age to James's
// public key and put in a Cloudflare R2 bucket over the S3 API.
// Nothing that runs here holds the private key, so nothing that runs
// can read a backup back. docs/backup.md has the restore.
//
//   BACKUP_AGE_RECIPIENT         James's age public key (age1...)
//   BACKUP_R2_ENDPOINT           https://<account>.r2.cloudflarestorage.com
//   BACKUP_R2_BUCKET             the dedicated bucket
//   BACKUP_R2_ACCESS_KEY_ID      the bucket's token, as an S3 key pair
//   BACKUP_R2_SECRET_ACCESS_KEY
//   HEALTHCHECKS_BACKUP_URL      the nightly check (period a day)

import { createHash, createHmac } from "node:crypto";

import { Encrypter } from "age-encryption";

import { alert, ping } from "./health.mjs";
import { log } from "./log.mjs";
import { deployContext } from "./store.mjs";

export const BACKED_UP = ["orders", "customers"];

export const VARIABLES = [
  "BACKUP_AGE_RECIPIENT", "BACKUP_R2_ENDPOINT", "BACKUP_R2_BUCKET",
  "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY",
];

const UPLOAD_TIMEOUT = 20_000;
const BATCH = 25;

// -> { format, at, context, counts, stores: { name: [{ key, value }] } }
export const dump = async (stores, {
  env = process.env, now = new Date(),
} = {}) => {
  const out = {
    format: "nff-backup", at: now.toISOString(),
    context: deployContext(env) || "dev", stores: {},
  };

  for (const name of BACKED_UP) {
    const keys = (await stores[name].list("")).map((k) => k.key);
    const records = [];

    for (let i = 0; i < keys.length; i += BATCH) {
      const slice = keys.slice(i, i + BATCH);
      const values = await Promise.all(slice.map((k) => stores[name].get(k)));

      slice.forEach((key, j) => {
        if (values[j] !== null) records.push({ key, value: values[j] });
      });
    }
    out.stores[name] = records;
  }
  out.counts = countsOf(out);

  return out;
};

// What a restore is checked against: keys per store, and the records
// a person would count.
export const countsOf = (backup) => {
  const all = backup.stores;
  const under = (name, prefix) =>
    (all[name] || []).filter((r) => r.key.startsWith(prefix));

  return {
    keys: Object.fromEntries(Object.entries(all)
      .map(([name, list]) => [name, list.length])),
    orders: under("orders", "order/").length,
    customers: under("customers", "customer/").length,
    subscribers: under("customers", "customer/")
      .filter((r) => r.value && r.value.marketing === true).length,
  };
};

export const encrypt = async (text, recipient) => {
  const e = new Encrypter();

  e.addRecipient(recipient);

  return e.encrypt(text);
};

// --- S3 Signature Version 4, enough for one PUT -------------------

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// RFC 3986, as SigV4 wants each path segment.
const encodeSegment = (s) => encodeURIComponent(s)
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// -> the headers to send, Authorization included. `headers` are
// signed with host; `payloadHash` is the body's SHA-256 in hex.
export const sign = ({
  method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey,
  region = "auto", service = "s3", now = new Date(),
}) => {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = amzDate.slice(0, 8);
  const all = {
    ...Object.fromEntries(Object.entries(headers)
      .map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(all).sort();
  const signed = names.join(";");
  const path = u.pathname.split("/").map((s) => encodeSegment(
    decodeURIComponent(s))).join("/");
  const canonical = [
    method, path, u.searchParams.toString(),
    names.map((n) => `${n}:${all[n]}\n`).join(""), signed, payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)]
    .join("\n");
  const key = [day, region, service, "aws4_request"]
    .reduce((k, part) => hmac(k, part), `AWS4${secretAccessKey}`);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");

  delete all.host;

  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signed}, Signature=${signature}`,
  };
};

export const putObject = async ({
  endpoint, bucket, key, body, accessKeyId, secretAccessKey,
  fetchImpl = globalThis.fetch, now = new Date(),
}) => {
  const url = `${endpoint.replace(/\/$/, "")}/${bucket}/${key}`;
  const headers = sign({
    method: "PUT", url, payloadHash: sha256(body),
    headers: { "content-type": "application/octet-stream" },
    accessKeyId, secretAccessKey, now,
  });
  const res = await fetchImpl(url, {
    method: "PUT", headers, body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");

    throw new Error(`R2 answered ${res.status}: ${text.slice(0, 300)}`);
  }
};

// --- The export -----------------------------------------------------

export const configured = (env = process.env) =>
  VARIABLES.some((name) => env[name]);

// -> "production/2026-10-16T07-00-00Z-nightly.json.age". Never the
// same key twice, so a bucket lock that forbids overwrites holds.
export const objectKey = (context, label, now = new Date()) =>
  `${context}/${now.toISOString().replace(/\.\d+/, "").replace(/:/g, "-")
  }-${label}.json.age`;

// Dump, encrypt, upload. -> { key, bytes, counts, encrypted }.
// `upload` false keeps the copy here only (bin/nff export --out).
export const exportBackup = async (stores, {
  env = process.env, fetchImpl = globalThis.fetch, now = new Date(),
  label = "nightly", upload = true,
} = {}) => {
  const needed = upload ? VARIABLES : ["BACKUP_AGE_RECIPIENT"];
  const missing = needed.filter((name) => !env[name]);

  if (missing.length) throw new Error(`Backup: ${missing.join(", ")} unset.`);

  const backup = await dump(stores, { env, now });
  const encrypted = await encrypt(JSON.stringify(backup),
    env.BACKUP_AGE_RECIPIENT);
  const key = objectKey(backup.context, label, now);

  if (upload) {
    await putObject({
      endpoint: env.BACKUP_R2_ENDPOINT, bucket: env.BACKUP_R2_BUCKET, key,
      body: encrypted, accessKeyId: env.BACKUP_R2_ACCESS_KEY_ID,
      secretAccessKey: env.BACKUP_R2_SECRET_ACCESS_KEY, fetchImpl, now,
    });
  }

  return { key, bytes: encrypted.length, counts: backup.counts, encrypted };
};

// The scheduled run. Unconfigured, it does nothing (a preview, a
// local run). A failure alerts as backup.failed and posts to the
// check's /fail; a night that never runs is the check's own alarm.
export const nightly = async (stores, {
  env = process.env, fetchImpl = globalThis.fetch, mail, now = new Date(),
} = {}) => {
  if (!configured(env)) {
    log.info({ event: "backup.skipped" });

    return { skipped: true };
  }

  try {
    const { key, bytes, counts } = await exportBackup(stores,
      { env, fetchImpl, now });

    log.info({ event: "backup.done", key, bytes, counts });
    await ping(env.HEALTHCHECKS_BACKUP_URL,
      { ok: true, body: { key, bytes, counts }, fetchImpl });

    return { key, bytes, counts };
  } catch (error) {
    const message = String((error && error.message) || error);

    log.error({ event: "backup.failed", error: message });
    await alert(stores, "backup.failed", { error: message },
      { env, mail, fetchImpl });
    await ping(env.HEALTHCHECKS_BACKUP_URL,
      { ok: false, body: { error: message }, fetchImpl });

    return { error: message };
  }
};

// Writes a decrypted backup's records into `stores`, which must be
// empty, and counts them back. -> { expected, found }; they agree.
export const restore = async (stores, backup) => {
  if (!backup || backup.format !== "nff-backup") {
    throw new Error("Not an nff backup (no format: nff-backup).");
  }

  for (const name of Object.keys(backup.stores)) {
    if (!stores[name]) throw new Error(`No store named ${name}.`);
    if ((await stores[name].list("")).length) {
      throw new Error(`The ${name} store is not empty; restore into a ` +
        "scratch one.");
    }
  }
  for (const [name, records] of Object.entries(backup.stores)) {
    for (const { key, value } of records) await stores[name].set(key, value);
  }

  const found = { format: "nff-backup", stores: {} };

  for (const name of Object.keys(backup.stores)) {
    const keys = await stores[name].list("");

    found.stores[name] = await Promise.all(keys.map(async ({ key }) =>
      ({ key, value: await stores[name].get(key) })));
  }

  return { expected: countsOf(backup), found: countsOf(found) };
};
