import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ESCALATING, acknowledge, alertRecipients, escalate, raise,
} from "../netlify/functions/lib/health.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { escalatedEmails } from "../netlify/functions/lib/mail.mjs";
import {
  parseRotationLog, pendingRevocations, reminderFor, revokeBy, rotationDaily,
  stillDue,
} from "../netlify/functions/lib/rotation.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const LOG = `# Rotation log

Name, date, environment, reason, who.

- NETLIFY_AUTH_TOKEN | 2026-01-03 | all | schedule | James
- SQUARE_ACCESS_TOKEN, 2026-01-03, production, schedule, James
- SQUARE_ACCESS_TOKEN, 2026-10-20, production, leak, James
| RESEND_API_KEY | 2026-12-02 | production | schedule | James |
| --- | --- | --- | --- | --- |
- AXIOM_TOKEN | 2026-03-01 | production | schedule | James
`;

const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com, other@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  ESCALATED_NOTIFICATIONS_EMAIL: "office@x.com",
};

// 8:30 in New York is 12:30 UTC in December.
const at = (day, time = "13:30") => new Date(`${day}T${time}:00Z`);

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

describe("the rotation log", () => {
  it("reads bullets, comma lines and table rows, and skips the rest",
    () => {
      const entries = parseRotationLog(LOG);

      assert.deepEqual(entries.map((e) => e.name), [
        "NETLIFY_AUTH_TOKEN", "SQUARE_ACCESS_TOKEN", "SQUARE_ACCESS_TOKEN",
        "RESEND_API_KEY", "AXIOM_TOKEN",
      ]);
      assert.deepEqual(entries[1], {
        name: "SQUARE_ACCESS_TOKEN", date: "2026-01-03",
        environment: "production", reason: "schedule", who: "James",
      });
    });

  it("reads nothing from nothing", () => {
    assert.deepEqual(parseRotationLog(null), []);
    assert.deepEqual(parseRotationLog(""), []);
  });

  it("keeps the latest rotation of each name and environment, and " +
    "lists those before the window", () => {
    const due = stillDue(parseRotationLog(LOG), "2026-12-01");

    assert.deepEqual(due.map((e) => [e.name, e.date]), [
      ["NETLIFY_AUTH_TOKEN", "2026-01-03"],
      ["AXIOM_TOKEN", "2026-03-01"],
      ["SQUARE_ACCESS_TOKEN", "2026-10-20"],
    ]);
  });

  it("counts a rotation inside the window as done", () => {
    const due = stillDue(parseRotationLog(LOG), "2026-12-01");

    assert.ok(!due.some((e) => e.name === "RESEND_API_KEY"));
  });
});

describe("the reminder days", () => {
  it("falls on Dec 1 and each week after, the last one final", () => {
    const days = ["01", "08", "15", "22", "29"].map((d) =>
      reminderFor(`2026-12-${d}`));

    assert.deepEqual(days.map((r) => r.on), [
      "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29",
    ]);
    assert.deepEqual(days.map((r) => r.final),
      [false, false, false, false, true]);
    assert.ok(days.every((r) => r.start === "2026-12-01"));
  });

  it("catches a missed day up on the days between", () => {
    assert.equal(reminderFor("2026-12-03").on, "2026-12-01");
    assert.equal(reminderFor("2026-12-14").on, "2026-12-08");
    assert.equal(reminderFor("2026-12-24").on, "2026-12-22");
    assert.equal(reminderFor("2026-12-31").on, "2026-12-29");
    assert.equal(reminderFor("2026-12-31").final, true);
  });

  it("is silent outside December and January", () => {
    for (const day of ["2026-11-30", "2027-02-01", "2026-06-15"]) {
      assert.equal(reminderFor(day), null, day);
    }
  });

  it("goes on weekly through January, never final, for the window " +
    "before it", () => {
    const days = ["01", "08", "15", "22", "29", "31"].map((d) =>
      reminderFor(`2027-01-${d}`));

    assert.deepEqual(days.map((r) => r.on), [
      "2027-01-01", "2027-01-08", "2027-01-15", "2027-01-22", "2027-01-29",
      "2027-01-29",
    ]);
    assert.ok(days.every((r) => !r.final && r.start === "2026-12-01"));
  });
});

describe("the old credentials still to revoke", () => {
  it("is 31 days after a rotation, or the Jan 31 after it if sooner",
    () => {
      assert.equal(revokeBy("2026-12-20"), "2027-01-20");
      assert.equal(revokeBy("2026-12-01"), "2027-01-01");
      assert.equal(revokeBy("2026-12-31"), "2027-01-31");
      assert.equal(revokeBy("2027-01-01"), "2027-01-31");
      assert.equal(revokeBy("2027-03-01"), "2027-04-01");
    });

  it("lists a scheduled rotation with no revoked line after it", () => {
    const entries = parseRotationLog(`
- RESEND_API_KEY | 2026-12-02 | production | schedule | James
- AXIOM_TOKEN | 2026-12-03 | production | schedule | James
- AXIOM_TOKEN | 2026-12-04 | staging | schedule | James
- AXIOM_TOKEN | 2027-01-02 | production | revoked | James
- SQUARE_ACCESS_TOKEN | 2026-12-05 | production | leak | James
- STAGING_TOKEN | 2026-12-05 | staging | schedule | James
- GATE_RESEND_KEY | 2026-10-18 | staging | seed | James
- PAYPAL_CLIENT_SECRET | 2025-12-03 | production | schedule | James
- BACKUP_R2_ACCESS_KEY_ID | 2026-12-06 | production | Scheduled | James
- HEALTHCHECKS_JOBS_URL | 2026-12-06 | production | Schedule | James
- HEALTHCHECKS_JOBS_URL | 2026-12-08 | production | Revoked | James
`);
    const pending = pendingRevocations(entries, "2027-01-10",
      "2026-12-01");

    assert.deepEqual(pending.map((e) => [e.name, e.environment, e.by]), [
      ["RESEND_API_KEY", "production", "2027-01-02"],
      ["AXIOM_TOKEN", "staging", "2027-01-04"],
      ["BACKUP_R2_ACCESS_KEY_ID", "production", "2027-01-06"],
    ]);
    assert.ok(pending.every((e) => e.overdue));
    assert.deepEqual(pendingRevocations(entries, "2026-12-20",
      "2026-12-01").map((e) => e.overdue), [false, false, false]);
  });

  it("does not count a revoked line as a rotation in the window", () => {
    const due = stillDue(parseRotationLog(`
- RESEND_API_KEY | 2026-10-20 | production | schedule | James
- RESEND_API_KEY | 2026-12-05 | production | revoked | James
`), "2026-12-01");

    assert.deepEqual(due.map((e) => e.date), ["2026-10-20"]);
  });

  it("rides in the email, and January sends it alone", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const text = `
- RESEND_API_KEY | 2026-12-02 | production | schedule | James
- AXIOM_TOKEN | 2026-12-03 | production | schedule | James
- AXIOM_TOKEN | 2026-12-30 | production | revoked | James
`;
    const run = (now) => rotationDaily(stores, {
      env, mail, now, readLogText: async () => text,
    });

    assert.equal((await run(at("2026-12-15"))).pending, 1);
    assert.match(sent[0].text, /Old credentials still to revoke/);
    assert.match(sent[0].text, /RESEND_API_KEY[^\n]*2027-01-02/);
    assert.doesNotMatch(sent[0].text, /AXIOM_TOKEN/);

    const jan = await run(at("2027-01-08"));

    assert.deepEqual(jan, {
      on: "2027-01-08", final: false, due: 0, pending: 1,
    });
    assert.equal(sent[1].subject, "Old credentials are waiting to be revoked");
    assert.match(sent[1].text, /overdue/);
    assert.match(sent[1].text, /Every secret is rotated, but the old/);
    assert.doesNotMatch(sent[1].text, /rotates between Dec 1 and Jan 1/);

    // Revoked at last: January goes quiet.
    const done = `${text}` +
      "- RESEND_API_KEY | 2027-01-09 | production | revoked | James\n";

    assert.equal(await rotationDaily(stores, {
      env, mail, now: at("2027-01-15"), readLogText: async () => done,
    }), null);
    assert.equal(sent.length, 2);
  });
});

describe("the reminder email", () => {
  const log = async () => LOG;

  it("goes out on Dec 1 to the developer, once", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const run = (now) => rotationDaily(stores, {
      env, mail, now, readLogText: log,
    });

    assert.equal(await run(at("2026-12-01", "12:30")), null,
      "not before 8:00 in New York");
    assert.deepEqual(await run(at("2026-12-01", "13:30")),
      { on: "2026-12-01", final: false, due: 3, pending: 1 });
    assert.equal(await run(at("2026-12-01", "20:00")), null, "once");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["dev@x.com"]);
    assert.match(sent[0].subject, /due for rotation/);
    assert.match(sent[0].text, /AXIOM_TOKEN/);
  });

  it("repeats weekly while the log shows something due", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    for (const day of ["01", "08", "15", "22"]) {
      await rotationDaily(stores, {
        env, mail, now: at(`2026-12-${day}`), readLogText: async () => LOG,
      });
    }
    assert.equal(sent.length, 4);
  });

  it("stops once the log shows everything rotated and revoked", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const done = `${LOG}
- NETLIFY_AUTH_TOKEN | 2026-12-03 | all | schedule | James
- AXIOM_TOKEN | 2026-12-03 | production | schedule | James
- SQUARE_ACCESS_TOKEN | 2026-12-04 | production | schedule | James
- RESEND_API_KEY | 2026-12-30 | production | revoked | James
- NETLIFY_AUTH_TOKEN | 2026-12-30 | all | revoked | James
- AXIOM_TOKEN | 2026-12-30 | production | revoked | James
- SQUARE_ACCESS_TOKEN | 2026-12-30 | production | revoked | James
`;

    await rotationDaily(stores, {
      env, mail, now: at("2026-12-01"), readLogText: log,
    });
    for (const day of ["08", "15", "22", "29"]) {
      const r = await rotationDaily(stores, {
        env, mail, now: at(`2026-12-${day}`), readLogText: async () => done,
      });

      assert.equal(r, null, day);
    }
    assert.equal(sent.length, 1);
  });

  it("makes the last one loud", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await rotationDaily(stores, {
      env, mail, now: at("2026-12-30"), readLogText: log,
    });
    assert.match(sent[0].subject, /^FINAL REMINDER/);
    assert.match(sent[0].text, /window closes in days/);
  });

  it("says so when the log is missing, and still sends", async () => {
    const { sent, mail } = mailbox();
    const r = await rotationDaily(testStores(), {
      env, mail, now: at("2026-12-08"), readLogText: async () => null,
    });

    assert.equal(r.due, 0);
    assert.match(sent[0].text, /rotation-log.md was not found/);
  });

  it("sends nothing outside December or with nobody to tell", async () => {
    const { sent, mail } = mailbox();

    for (const day of ["2026-11-30", "2027-02-02"]) {
      assert.equal(await rotationDaily(testStores(), {
        env, mail, now: at(day), readLogText: log,
      }), null);
    }
    assert.equal(await rotationDaily(testStores(), {
      env: {}, mail, now: at("2026-12-01"), readLogText: log,
    }), null);
    assert.equal(sent.length, 0);
  });

  it("does not fall back to the farm address", async () => {
    const { sent, mail } = mailbox();

    await rotationDaily(testStores(), {
      env: { FARM_NOTIFICATIONS_EMAIL: "farm@x.com" },
      mail, now: at("2026-12-01"), readLogText: log,
    });
    assert.equal(sent.length, 0);
  });

  it("tries again after a mail failure", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const now = at("2026-12-01");
    const failing = async () => {
      throw new Error("resend down");
    };

    await assert.rejects(rotationDaily(stores, {
      env, mail: failing, now, readLogText: log,
    }), /resend down/);
    await rotationDaily(stores, { env, mail, now, readLogText: log });
    assert.equal(sent.length, 1);
  });

  it("runs as a step of the jobs and shows in the report", async () => {
    const { sent, mail } = mailbox();
    const report = await runJobs(testStores(), {
      env, mail, now: at("2026-12-01"),
    });

    assert.equal(report.rotation.on, "2026-12-01");
    assert.ok(sent.some((m) => /rotation/i.test(m.subject)));
  });
});

describe("who hears an alert", () => {
  const kinds = ["order.create_failed", "payment.unreconciled",
    "pickup.lapsed", "jobs.errors", "jobs.crashed", "backup.failed",
    "webhook.rejected", "function.crashed", "jobs.invariants",
    "mail.failed", "some.new_kind"];

  it("sends every alert to the developer only", () => {
    for (const kind of kinds) {
      assert.deepEqual(alertRecipients(kind, env), ["dev@x.com"], kind);
    }
  });

  it("has no fallback when the developer address is unset", () => {
    const { DEV_NOTIFICATIONS_EMAIL, ...rest } = env;

    assert.ok(DEV_NOTIFICATIONS_EMAIL);
    for (const kind of kinds) {
      assert.deepEqual(alertRecipients(kind, rest), [], kind);
    }
  });

  it("never lets an alert reach the escalation address", async () => {
    const { sent, mail } = mailbox();

    for (const kind of [...kinds, ...ESCALATING]) {
      assert.ok(!alertRecipients(kind, env).includes("office@x.com"), kind);
      await raise(testStores(), kind, {}, { env, mail });
    }
    assert.ok(sent.length);
    for (const m of sent) assert.deepEqual(m.to, ["dev@x.com"], m.subject);
  });

  it("raises through those recipients", async () => {
    const { sent, mail } = mailbox();

    await raise(testStores(), "jobs.errors", { count: 1 }, { env, mail });
    await raise(testStores(), "order.create_failed", {}, { env, mail });
    assert.deepEqual(sent.map((m) => m.to), [["dev@x.com"], ["dev@x.com"]]);
  });
});

describe("the escalation", () => {
  const kind = ESCALATING[0];
  const t0 = new Date("2026-10-20T15:00:00Z");
  const minutes = (n) => new Date(t0.getTime() + n * 60_000);

  it("waits an hour, then mails the escalation address alone", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await raise(stores, kind, {}, { env, mail, now: t0 });
    assert.deepEqual(sent.map((m) => m.to), [["dev@x.com"]]);
    assert.deepEqual(await escalate(stores, { env, mail, now: minutes(59) }),
      []);
    assert.deepEqual(await escalate(stores, { env, mail, now: minutes(60) }),
      [kind]);
    assert.deepEqual(sent.at(-1).to, ["office@x.com"]);
    assert.match(sent.at(-1).text, /James hasn't responded/);
    assert.match(sent.at(-1).text, /maintenance mode/);
    assert.doesNotMatch(sent.at(-1).text, new RegExp(kind));
  });

  it("repeats hourly until acknowledged, then stops", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await raise(stores, kind, {}, { env, mail, now: t0 });
    await escalate(stores, { env, mail, now: minutes(60) });
    assert.deepEqual(await escalate(stores, { env, mail, now: minutes(90) }),
      []);
    assert.deepEqual(await escalate(stores, { env, mail, now: minutes(120) }),
      [kind]);
    assert.equal(await acknowledge(stores, kind, minutes(121)), true);
    assert.deepEqual(await escalate(stores, { env, mail, now: minutes(240) }),
      []);
    assert.equal(sent.filter((m) => m.to[0] === "office@x.com").length, 2);
  });

  it("is quiet when acknowledged inside the hour", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    await raise(stores, kind, {}, { env, mail, now: t0 });
    await acknowledge(stores, kind, minutes(30));
    assert.deepEqual(await escalate(stores, { env, mail, now: minutes(90) }),
      []);
    assert.equal(sent.length, 1);
  });

  it("sends nothing for any other alert", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();

    for (const other of ["order.create_failed", "payment.unreconciled",
      "jobs.errors", "function.crashed"]) {
      await raise(stores, other, {}, { env, mail, now: t0 });
    }
    sent.length = 0;
    assert.deepEqual(await escalate(stores, { env, mail, now: minutes(600) }),
      []);
    assert.equal(sent.length, 0);
  });

  it("sends nothing when the escalation address is unset", async () => {
    const stores = testStores();
    const { sent, mail } = mailbox();
    const bare = { ...env, ESCALATED_NOTIFICATIONS_EMAIL: "" };

    await raise(stores, kind, {}, { env: bare, mail, now: t0 });
    sent.length = 0;
    assert.deepEqual(
      await escalate(stores, { env: bare, mail, now: minutes(120) }), []);
    assert.equal(sent.length, 0);
    assert.deepEqual(escalatedEmails({}), []);
  });
});
