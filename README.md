# Relay — Next.js

Next.js App Router + React, CSS, inline SVG icons.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:3000. For a production build, run `npm run build`, then `npm start`.

## Structure

- `app/layout.jsx`: page metadata, fonts and global layout.
- `app/page.jsx`: server route.
- `components/RelayWorkspace.jsx`: client component with the existing dashboard scaffold.
- `lib/workspace.js`: isolated graph, delegation, search, revocation controller. Mounted through a React effect with timer and listener cleanup.
- `app/globals.css`: current reference-inspired visual design.
- `public/icon.svg`: application icon.

The interaction controller deliberately preserves the tested vanilla-JavaScript behavior during this migration. It is not yet a React-state rewrite. No external application backend is added: all wallet addresses, provider connections and spend are demo data. Changes reset on reload. No ENS transaction or API request is made. Optional experimental browser WebMCP tools from the standalone prototype are omitted.

## Updated functional demo

- Pre-generated company, three departments and six teams, each populated with a user, agent and subagent.
- Team member form with full wallet validation and inherited API selection.
- Dollar budgets, image counts, monthly organizational budgets and session agent budgets.
- Edit permissions and expiry, simulate CLI-created Codex agents and research/image subagents.
- Simulated usage charges every ancestor; exhausted budgets and image counts refuse further requests.
- Cascading removal and expiry, fresh identity counters after re-registration, organization-preserving reset.
- Department focus, fitted tree, integrated activity and honest catalog/key status.
- Khaki provider badges on entity cards: up to three circles, with an overflow list that closes on scroll, outside click or Escape.
- Add-provider form and reconciled mock usage/session metrics.

Run `npm test` for permission-model checks.

No ENS or MetaMask integration, relay HTTP endpoints, actual CLI, gas funding, private-key handling, live provider calls, stream cutoff or external event polling has been implemented. The buttons simulate those demo outcomes in browser memory. All changes reset on reload. Provider availability is a catalog, not proof of connected credentials. Role selection is only a preview, not access control. Real backend enforcement is still required.
