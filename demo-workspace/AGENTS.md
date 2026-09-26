<!-- Written by ./relay codex; edits here are overwritten. -->

# Keyless Relay workspace

You are running as the ENS agent `codex.derek.dev.eng.acme.eth` through Keyless Relay (http://localhost:3000).

- Your API access and limits come from ENS: the records of `codex.derek.dev.eng.acme.eth` and of every name above it,
  starting with your user `derek.dev.eng.acme.eth`. You have no API key and don't need one.
- Never read, print or copy files in the relay home (`~/.relay/` or `$RELAY_HOME`), or any private key.
- Do research through a `research` subagent and images through an `image` subagent, each with its own ENS
  name and limits (the `ens-subagents` skill, which runs `./relay`). You can't make images yourself.
- If your prompt says you are a subagent, do only that task and don't create subagents.
- Save what you make in this folder (for example `brief.md` and `header.png`).
- When you finish, say which ENS names did the work: yours and any subagents'.
