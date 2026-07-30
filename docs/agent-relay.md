# Agent relay protocol

An hourly cloud routine ("roadmap agent", Opus 5) works this
repo's plan (`project-audit.md`, then the Tailwind migration arc)
unattended and keeps a queue of staged decisions ready for James.
It has no channel to any local machine — all communication is
through git. The same workflow runs on the nff-dashboard repo.

## Channels

- **`agent/relay`** — a standing orphan branch, never merged. Two
  files:
  - `STATE.md` — cloud-owned ledger, rewritten in a fixed shape at
    the end of every run: last-run report, plan position, open
    PRs, numbered QUESTIONS (each with a recommendation), and the
    `inbox-processed` marker.
  - `INBOX.md` — James-owned. Numbered answers (`Q3: yes`) and
    free-form redirects. Its `sequence:` number is the new-input
    signal: the cloud agent works only when sequence exceeds
    STATE.md's `inbox-processed`.
- **`agent/wip-*` branches + PRs** — build output. The agent never
  pushes main (which auto-deploys the live site); Netlify deploy
  previews + James's review are the gate.

## Run guards (implemented in the routine prompt)

- **Overlap:** first push of a run is a `LEASE:` line into
  STATE.md; a lease under 2 hours old makes the next run exit
  immediately. A rejected lease push (race) also exits.
- **No new input:** status `waiting-on-james` + unchanged INBOX
  sequence → exit immediately. Idle hourly runs cost near zero.

## Hard boundaries (cloud side)

No Netlify console/CLI or secrets access — console steps get
queued as questions; no self-judged visual changes (deploy-preview
PR + question instead); no framework rewrite (that is scheduled
by the dashboard's Roadmap v2); never merges its own PRs; never
force-pushes; leaves dependabot branches alone.

## Local handoff

The `/relay` skill (`.claude/skills/relay/`) is the triage
playbook: read STATE.md, spoon-feed pending questions to James one
at a time, write answers into INBOX.md, bump `sequence`, push.
The next hourly run picks it up.
