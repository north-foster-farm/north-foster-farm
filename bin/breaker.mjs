// `bin/nff breaker ...`: the Resend send breaker's controls
// (netlify/functions/lib/breaker.mjs, docs/secrets.md "Resend").
// Resetting is deliberate and never automatic.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  declare, flush, incidentReport, reset, status,
} from "../netlify/functions/lib/breaker.mjs";
import { sendMail } from "../netlify/functions/lib/mail.mjs";
import {
  customerEmailWithheld,
} from "../netlify/functions/lib/payments.mjs";

export const USAGE = `  bin/nff breaker status [--production]
                                      tripped or not, this hour's and
                                      today's sends against the limits,
                                      declared bulk sends, mail held
  bin/nff breaker declare --count <n> [--hours 24] [--note "launch"]
                                      announce a planned bulk send (the
                                      launch invitations) before it
                                      starts: raises the hourly and
                                      daily ceilings by n for that
                                      window only
  bin/nff breaker reset --yes [--production]
                                      after a trip: the new sending key
                                      is in Netlify and deployed, and
                                      the cause is understood. Clears
                                      the breaker, writes the incident
                                      to incidents/, keeps held mail
  bin/nff breaker flush [--dry-run] [--production]
                                      send the mail held while it was
                                      tripped (older than 72 hours is
                                      dropped, not sent)`;

const line = (state) => (state
  ? `TRIPPED ${state.at}: ${state.reason} ${JSON.stringify(state.detail)}`
  : "Not tripped.");

export const breakerCommand = async (action, {
  stores, flags, out, root, now = new Date(),
}) => {
  switch (action) {
  case "status": {
    const s = await status(stores, now);

    out(line(s.state));
    if (s.state) {
      out(`  Sending key: ${s.state.key && s.state.key.done
        ? "deleted" : `NOT deleted (${s.state.key && s.state.key.why})`}.`);
      out(`  Phone alert: ${s.state.alerted ? "sent" : "NOT sent"}.`);
    }
    out(`  Sends: ${s.counts.hour} of ${s.limits.hour} this hour, ` +
      `${s.counts.day} of ${s.limits.day} today (UTC)` +
      `${s.limits.declared ? `, ${s.limits.declared} declared` : ""}.`);
    out(`  Last 2 hours: ${s.reputation.sent} sent, ` +
      `${s.reputation.bounced} bounced, ${s.reputation.complained} ` +
      "complained.");
    for (const d of s.declared) {
      out(`  Declared: ${d.count} until ${d.until} (${d.note || "no note"}).`);
    }
    out(`  Held mail: ${s.unsent}.`);
    if (s.unconfirmed.length) {
      out(`  WARNING: ${s.unconfirmed.length} sends over 15 minutes old ` +
        "never came back as email.sent. Is the webhook subscribed to " +
        "email.sent? A foreign send would go unseen.");
      process.exitCode = 1;
    }

    return undefined;
  }
  case "declare": {
    const count = Number(flags.count);
    const hours = flags.hours === undefined ? 24 : Number(flags.hours);
    const d = await declare(stores, {
      count, hours, note: typeof flags.note === "string" ? flags.note : "",
      now,
    });

    return out(`Declared ${d.count} emails until ${d.until}.`);
  }
  case "reset": {
    if (!flags.yes) {
      throw new Error("Reset only once the new sending key is in " +
        "Netlify and deployed and you know the cause. Run again with " +
        "--yes.");
    }

    const r = await reset(stores, { now });

    if (!r.state) return out("The breaker was not tripped. Baseline reset.");

    const file = join(root, "incidents",
      `${r.state.at.slice(0, 10)}-resend-breaker.md`);

    writeFileSync(file, incidentReport(r.state, { now }));
    out(`Reset. Incident written to ${file}; add the cause to it.`);

    return out(`${r.unsent} held emails wait for: bin/nff breaker flush`);
  }
  case "flush": {
    if (customerEmailWithheld() && !flags["dry-run"]) {
      throw new Error("A flush sends held customer email, so it won't " +
        "run with --no-email. Drop the flag, or use --dry-run.");
    }

    const r = await flush(stores, (m) => sendMail(m, { stores }), {
      now, dryRun: !!flags["dry-run"],
    });

    for (const h of r.held) out(`  ${h.at}  ${h.subject}`);

    return out(flags["dry-run"]
      ? `${r.held.length} held; a real flush sends those under 72 hours.`
      : `Sent ${r.sent}, dropped as stale ${r.stale}, failed ${r.failed}.`);
  }
  default:
    throw new Error(`Usage:\n${USAGE}`);
  }
};
