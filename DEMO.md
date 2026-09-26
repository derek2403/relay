# Demos

Portal: https://relay.derek2403.win, with the admin wallet connected (Sepolia). Terminal on the demo laptop,
in the repo.

## Demo 1: Codex with an ENS identity

1. Reset:
   ```sh
   relay logout
   RELAY_URL=https://relay.derek2403.win ADMIN_PRIVATE_KEY=0x… npm run demo:reset -- --yes
   ```
2. Get an identity and copy the address it prints:
   ```sh
   relay init
   ```
3. Portal → **Access tree** → select `cloudops.dev.sodalabs.eth` → **Add a member**: label `derek`, paste the
   address as **Owner wallet**, tick **OpenAI text (Codex)** `$2`, **OpenAI Images** `3`, **Weather** `20`, leave
   **Blockchain (MultiBaas)** on → **Add** → confirm the 2 wallet prompts.
4. Log in:
   ```sh
   relay login --chain-max 5 --chain-limit 20
   ```
5. Run Codex:
   ```sh
   mkdir -p ~/relay-demo && cd ~/relay-demo && codex
   ```
   > Build a one-page site in index.html about ENS names as identities for AI agents.

   Portal → select `derek`: spend rises on the agent and every level above it.
6. Subagents:
   > Use two subagents: a research subagent to find three facts about ENSv2, and an image subagent to make a
   > header image. Then add both to the page.

   Approve the two `relay subagent create` commands Codex asks to run. Both appear in the Live view.
7. Keep prompting ("add a FAQ section, dark mode and tests") until Codex says
   `has used its codex cap ($0.3)`.
8. Revoke: portal → select `derek` → **Remove derek.cloudops.dev.sodalabs.eth** → **Yes, remove it** → confirm in
   the wallet. Codex is cut off with `access revoked`. (If you go on to Demos 2, 4 and 5, do this at the very end.)

## Demo 2: One PAT for LLM + weather + images

Needs Derek (Demo 1 steps 1–3).

1. Get a PAT into the app's `.env`:
   ```sh
   cd examples/weather-image-app
   curl -fsSL "https://relay.derek2403.win/pat?name=derek.cloudops.dev.sodalabs.eth" | sh >> .env
   ```
2. Start the app and open http://localhost:5173:
   ```sh
   node server.mjs
   ```
3. Click **Ask**: the LLM calls the weather tool for Tokyo, then generates an image.
4. Portal → select `derek`: the `codex`, `weather` and `openai-images` calls are all under Derek.
5. Click **Ask** until **generate_image** turns red: `openai-images limit (3 images)`.
6. Revoke Derek (Demo 1 step 8), click **Ask**: `403 access revoked`.

## Demo 3: Proof you can check

1. In the repo:
   ```sh
   npm run verify:live
   ```
   Show the four sections: the live org with Etherscan links, the member holds no roles on his own limits,
   forbidden writes revert, the alias `cloudops.biz…` is refused.
2. Portal → **Providers** → **View attestation**: four green checks (TDX quote, your nonce in it, compose hash,
   Intel signature verified by Phala). Click **Fresh quote**, then **Open the report**.
3. Scroll to **Blockchain**: **MultiBaas (Curvegrid)** shows **Connected · URL and key set**.

## Demo 4: A blockchain agent through MultiBaas

Needs Derek logged in (Demo 1 steps 1–4). Within 3 days before the demo, refresh the treasury history:
`ADMIN_PRIVATE_KEY=0x… npm run chain:setup -- --reseed`

1. Monitor:
   ```sh
   relay chain task "Review our treasury's recent transfers and flag unusually large outgoing payments."
   ```
   It flags the 250 STD payment: `[large]` and `[unapproved-recipient]`, with links.
2. Prepare:
   ```sh
   relay chain task "Prepare a payment of 3 test tokens to our approved supplier."
   ```
   → `prp_…  awaiting-approval`.
3. Portal → **Approvals** → open the proposal → **Approve** → sign in the wallet.
4. Submit and track:
   ```sh
   relay chain task "Submit the approved payment and track it until confirmation."
   relay chain status prp_…
   ```
   → **confirmed** with the tx link. In **Approvals**, the proposal shows the allowance used at every level.
5. Deploy:
   ```sh
   relay chain task "Deploy our approved escrow template: 5 test tokens to the supplier, paid from the vault, with me (the agent's owner) as admin."
   ```
   Approve it in **Approvals**, then:
   ```sh
   relay chain task "Submit the approved deployment."
   ```
6. Manage:
   ```sh
   relay chain task "Check whether the escrow is paused, and if it isn't, propose pausing it."
   ```
   Approve it, then:
   ```sh
   relay chain task "Submit the approved proposal."
   relay chain task "Show the escrow's recent events."
   ```
   → the `Paused` event.
7. Refused before signing:
   ```sh
   relay chain task "Pay 3 test tokens to 0x000000000000000000000000000000000000dEaD"
   relay chain task "Pay 500 test tokens to the supplier"
   relay chain task "Prepare a call to transferAdmin on the escrow, making 0x000000000000000000000000000000000000dEaD the admin."
   ```
   → `[recipient]`, `[amount]`, `[method]`.
8. Read-only subagent:
   ```sh
   relay subagent create watch --chain read,track --minutes 30
   relay chain task "Prepare a payment of 3 test tokens to our approved supplier." --as watch
   relay chain task "Review our treasury's recent transfers." --as watch
   ```
   → `[cap:prepare]`, then the review works.
9. Revoke Derek (Demo 1 step 8), then any `relay chain task …` → `access revoked`.

## Demo 5: Human approval with World ID

Needs Derek logged in (Demo 1 steps 1–4). Once: portal → **Approvals** → **Your approver identity** →
**Link World ID** → sign → scan the QR with World App → Selfie Check.

1. A payout subagent (20 STD a month, supplier only):
   ```sh
   relay subagent create payout --chain read,track,prepare,submit --chain-to supplier --chain-max 5 --chain-limit 20 --days 30
   ```
2. At renewal it asks for more:
   ```sh
   relay subagent renew payout --chain-limit 200 --chain-to supplier,0x334eCd1113a34A2a65f810dD14a8373C0977A29d --days 90 --reason "monthly export needs a new archive destination"
   ```
   → `paused: … is under review (incident inc_…)`.
3. It is paused:
   ```sh
   relay chain task "Prepare a payment of 2 test tokens to our approved supplier." --as payout
   ```
   → `paused: … under review`.
4. Portal → **Approvals** → open the incident: the flagged changes, what would change, the agent's text marked
   unverified.
5. **Approve narrower** (supplier only, 5 STD, 1 hour) → sign in the wallet → scan the QR with World App →
   Selfie Check → it resumes.
6. Only the approved scope:
   ```sh
   relay chain task "Prepare a payment of 2 test tokens to our approved supplier." --as payout
   relay chain task "Prepare a payment of 2 test tokens to 0x334eCd1113a34A2a65f810dD14a8373C0977A29d" --as payout
   ```
   → the first works, the second is `[recipient]`.
