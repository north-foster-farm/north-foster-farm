import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  missingFromLog, requiredNames, sampleNames, secretRows,
} from "../bin/check-rotation-log.mjs";

const sample = [
  "# A comment",
  "SQUARE_ENV=",
  "SQUARE_ACCESS_TOKEN=",
  "RESEND_AUDIENCE_ID=",
  "BACKUP_R2_ACCESS_KEY_ID=",
  "BACKUP_R2_SECRET_ACCESS_KEY=",
  "HEALTHCHECKS_JOBS_URL=",
  "MAINTENANCE_SECRET",
  "",
].join("\n");

const secrets = [
  "| Name | Kind | Set on | Also kept in | Issued by |",
  "| --- | --- | --- | --- | --- |",
  "| `SQUARE_ACCESS_TOKEN` | secret | production | env file | Square |",
  "| `OLD_KEY` | secret, old | production | none | Resend |",
  "| `NEXT_KEY` | secret, optional | production | env file | Square |",
  "| `PAYPAL_WEBHOOK_ID` | id | production | env file | PayPal |",
  "| `HEALTHCHECKS_JOBS_URL`, `_BACKUP_URL` | ping URLs | each | env | hc |",
  "| `BACKUP_R2_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | secret | p | e | C |",
  "| The age private key | secret | Mac | offline | us |",
  "| `PAYPAL_*_EMAIL`, `_PASSWORD` | sandbox logins | staging | pm | PP |",
  "",
  "| Not | The table |",
].join("\n");

const log = [
  "name | date | environment | reason | who",
  "--- | --- | --- | --- | ---",
  "SQUARE_ACCESS_TOKEN | 2026-10-18 | production | seed | prod agent",
  "square_access_token | 2026-10-18 | staging | seed | prod agent",
].join("\n");

describe("rotation log coverage: reading the sources", () => {
  it("reads sample names with or without a value", () => {
    assert.deepEqual(sampleNames(sample), [
      "SQUARE_ENV", "SQUARE_ACCESS_TOKEN", "RESEND_AUDIENCE_ID",
      "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY",
      "HEALTHCHECKS_JOBS_URL", "MAINTENANCE_SECRET",
    ]);
  });

  it("expands a _SUFFIX to the sample names that end in it", () => {
    const rows = secretRows(secrets, sampleNames(sample));
    const row = rows.find((r) => r.kind === "ping URLs");

    assert.deepEqual(row.names, ["HEALTHCHECKS_JOBS_URL"]);
    assert.deepEqual(
      rows.find((r) => r.names.includes("BACKUP_R2_ACCESS_KEY_ID")).names,
      ["BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY"]);
  });

  it("names a row with no backticks in words, without 'The'", () => {
    const rows = secretRows(secrets, []);

    assert.ok(rows.some((r) => r.names[0] === "age private key"));
  });

  it("requires secrets, URLs and sample secrets; leaves out the rest", () => {
    assert.deepEqual(requiredNames(secrets, sample), [
      "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY",
      "HEALTHCHECKS_JOBS_URL", "MAINTENANCE_SECRET",
      "SQUARE_ACCESS_TOKEN", "age private key",
    ]);
  });
});

describe("rotation log coverage: the check", () => {
  it("lists every required name the log lacks, case aside", () => {
    assert.deepEqual(missingFromLog(requiredNames(secrets, sample), log), [
      "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY",
      "HEALTHCHECKS_JOBS_URL", "MAINTENANCE_SECRET", "age private key",
    ]);
  });

  it("passes when the log names them all", () => {
    assert.deepEqual(missingFromLog(["A_KEY", "b token"],
      "a_key | 2026-01-01 | production | seed | me\n" +
      "B Token | 2026-01-01 | all | seed | me\n"), []);
  });

  it("holds for the real files: every secret has a line", () => {
    const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url),
      "utf8");
    const required = requiredNames(read("docs/secrets.md"),
      read(".env.sample"));

    assert.ok(required.length > 15, "found the secrets");
    assert.deepEqual(missingFromLog(required, read("docs/rotation-log.md")),
      []);
  });
});
