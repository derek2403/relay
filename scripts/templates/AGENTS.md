<!-- Written by {{CMD}} codex; edits here are overwritten. -->

# Keyless Relay workspace

You are running as the ENS agent `{{AGENT}}` through Keyless Relay ({{RELAY}}).

- Your API access and limits come from ENS: the records of `{{AGENT}}` and of every name above it,
  starting with your user `{{USER}}`. You have no API key and don't need one.
- Never read, print or copy files in the relay home (`~/.relay/` or `$RELAY_HOME`), or any private key.
- Do research through a `research` subagent and images through an `image` subagent, each with its own ENS
  name and limits (the `ens-subagents` skill, which runs `{{CMD}}`). You can't make images yourself.
- If your prompt says you are a subagent, do only that task and don't create subagents.
- Save what you make in this folder (for example `brief.md` and `header.png`).
- When you finish, say which ENS names did the work: yours and any subagents'.
