---
name: ens-subagents
description: Delegate research or image generation to a subagent that gets its own ENS name, key and budget under {{AGENT}}. Use it when a task needs research or an image, or when part of the work should run on a separate, smaller budget.
---

<!-- Written by {{CMD}} codex; edits here are overwritten. -->

# ENS subagents

A subagent is a real ENS name under `{{AGENT}}`, with its own key and its own limits written on ENS.
It expires on its own. Run these commands from this folder, one at a time: each `subagent create` sends
Sepolia transactions and takes about 30 seconds. If one fails with a nonce error, run it again.

## Research

```bash
{{CMD}} subagent create research --codex 1 --minutes 20
{{CMD}} exec --as research "<the research question; ask for a short summary with sources>"
```

The research subagent runs Codex on its own $1 budget and prints its answer.

## An image

```bash
{{CMD}} subagent create image --images 1 --minutes 20
{{CMD}} image --as image --prompt "<what the image shows>" --out header.png
```

It can make exactly one image. A second attempt is refused.

## Checking

- `{{CMD}} subagent create` prints JSON like `{"name": "research.{{AGENT}}", "expiry": 1790000000}`. Use that name in your report.
- `{{CMD}} subagent list` shows your subagents, when they expire and what they spent.

## When something is refused

- `… has used its … limit` or `… cap`: that budget is spent. Don't retry, and don't create another
  subagent to get around it. Stop that part of the work and report what was refused.
- Anything that starts with `access revoked` (for example `access revoked: <name> was removed or expired.
  Run {{CMD}} login.`): your access was taken away. Stop all work and report it. Don't retry, and don't
  run `{{CMD}} login` yourself.
