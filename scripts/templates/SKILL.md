---
name: ens-subagents
description: Delegate research or image generation to a subagent that gets its own ENS name, key and budget under {{AGENT}}, and run blockchain tasks (Sepolia, through the relay's MultiBaas tools) within the grant on ENS. Use it when a task needs research, an image, on-chain reads, a payment or contract proposal, or when part of the work should run on a separate, smaller budget.
---

<!-- Written by {{CMD}} codex; edits here are overwritten. -->

# ENS subagents

A subagent is a real ENS name under `{{AGENT}}`, with its own key and its own limits written on ENS.
It expires on its own. Run these commands from this folder, one at a time: each `subagent create` sends
Sepolia transactions and takes about 30 seconds. If one fails with a nonce error, run it again.

These commands need the network and write the subagent's key to ~/.relay, so when your sandbox blocks
them, ask to run them outside the sandbox (escalated permissions) instead of working around it.

## Research

```bash
{{CMD}} subagent create research --codex 0.1 --minutes 5
{{CMD}} exec --as research "<the research question; ask for a short summary with sources>"
```

The research subagent runs Codex on its own $0.10 budget for 5 minutes and prints its answer.

## An image

```bash
{{CMD}} subagent create image --images 1 --minutes 5
{{CMD}} image --as image --prompt "<what the image shows>" --out header.png
```

It can make exactly one image. A second attempt is refused.

## Blockchain (Sepolia, through the relay)

The relay holds the MultiBaas key and the signing wallet; you never do. What you may do on-chain is
the `relay.chain` grant on ENS (capabilities, contracts, methods, recipients, amounts), narrowed at
every level above you. Payments and contract changes become proposals that a human approves.

```bash
{{CMD}} chain task "review the treasury vault's recent transfers and flag anything unusual"
{{CMD}} chain task "pay 3 STD to our approved supplier"
{{CMD}} chain proposals                 # your proposals and their states
{{CMD}} chain submit <prp_…>            # only once a human approved it
{{CMD}} chain status <prp_…>            # submitted → included → confirmed, tx hash and block
```

- `chain task` prints the plan, what ran, findings, proposals and a report. A finding is a rule match,
  not proof of wrongdoing: say so in your report.
- A step shown as `blocked [rule]` was refused before anything was signed. Report the rule; don't
  rephrase the task to get around it.
- A proposal `awaiting-approval` waits for a human. Tell the user its id; don't submit it yourself
  until `chain status` shows `approved`.
- A subagent with its own, narrower grant (for example read-only monitoring):
  `{{CMD}} subagent create watch --chain read,track --days 1`, then `{{CMD}} chain task --as watch "…"`.
- To renew a subagent with other limits, use `{{CMD}} subagent renew <label> [--chain-limit …] [--chain-to …] [--days N] --reason "…"`.
  The relay reviews it first.

## Checking

- `{{CMD}} subagent create` prints JSON like `{"name": "research.{{AGENT}}", "expiry": 1790000000}`. Use that name in your report.
- `{{CMD}} subagent list` shows your subagents, when they expire and what they spent.

## When something is refused

- `… has used its … limit` or `… cap`: that budget is spent. Don't retry, and don't create another
  subagent to get around it. Stop that part of the work and report what was refused.
- If a command prints `paused:` (for example `paused: payout.{{AGENT}} is under review (incident inc_…)`):
  stop, report the incident id, and wait for a human. Don't retry, and don't write limits another way
  (no new subagent, no other flags, no direct ENS writes).
- Anything that starts with `access revoked` (for example `access revoked: <name> was removed or expired.
  Run {{CMD}} login.`): your access was taken away. Stop all work and report it. Don't retry, and don't
  run `{{CMD}} login` yourself.
