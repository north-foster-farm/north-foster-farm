---
name: relay
description: Triage the cloud roadmap agent's ledger — spoon-feed
  its pending questions to James, record answers in INBOX.md on
  agent/relay, and push so the next hourly run picks them up.
---

# /relay — cloud-agent handoff triage

Protocol background: `docs/agent-relay.md`. The cloud agent's
ledger lives on the orphan branch `agent/relay` (`STATE.md` +
`INBOX.md`).

## Steps

1. **Fetch and read the ledger** — do NOT switch branches:

       git fetch origin agent/relay
       git show origin/agent/relay:STATE.md
       git show origin/agent/relay:INBOX.md

   If STATE.md line 1 is a `LEASE:` under 2 hours old, a cloud run
   is in flight — tell James and offer to wait or read anyway.

2. **Report status first**: summarize "Last run", roadmap
   position, and open PRs in a few sentences. Link any PRs
   awaiting review — merging them is part of the handoff.

3. **Spoon-feed the QUESTIONS one at a time**, in order, each with
   the agent's recommendation (add your own view if it differs).
   One question per exchange; James may type answers. Also invite
   redirects ("skip X", "prioritize Y").

4. **Write the answers back.** In a temp worktree or via a direct
   ref update, edit INBOX.md on `agent/relay`:
   - Append answers under `## Answers` as `Q<n>: <answer>`.
   - Append any redirects under `## Redirects`.
   - Increment the `sequence:` number by 1.
   Leave STATE.md alone — it is cloud-owned. Commit
   (`Relay answers through Q<n>`) and push the branch.
   Pushing agent/relay is part of this skill's standing flow; it
   is not a main push and needs no extra confirmation.

5. **Confirm to James**: answers through Q\<n\> relayed; the next
   hourly run (top of the hour, roughly) will act on them.

## Worktree recipe for step 4

    git worktree add /tmp/relay-wt agent/relay
    # edit /tmp/relay-wt/INBOX.md
    git -C /tmp/relay-wt commit -am "Relay answers ..."
    git -C /tmp/relay-wt push origin agent/relay
    git worktree remove /tmp/relay-wt
