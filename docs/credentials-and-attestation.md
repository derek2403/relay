# Service credentials and attestation

Two relay features behind the live **Providers** view:

1. **Encrypted service credentials.** The wallet that owns the company root on ENS can set the relay's provider keys from the portal. Keys are stored encrypted and can't be read back.
2. **View attestation.** The relay gets a TDX quote from Phala's dstack that is bound to a statement about the relay (its root, pinned owner, and which APIs have keys).

## How credentials work

- **Storage.** Values are kept in `<RELAY_DATA_DIR>/credentials.json`, sealed as one AES-256-GCM blob. The key comes from `RELAY_SECRET` (HKDF-SHA256), and every write uses a fresh salt and IV. The file is written atomically (tmp file, fsync, rename) with mode 0600. Labels of custom services are encrypted too.
- **What can be stored.** You can store one value per catalog key variable (`lib/relay/catalog.ts`). `OPENAI_API_KEY` serves both `codex` and `openai-images`. You can also store the non-secret `RELAY_UPSTREAM_MAILCHIMP`, which must be a `https://<dc>.api.mailchimp.com` URL, so a stored value can't send a key to another host. Other settings (`RELAY_ROOT_OWNER` and so on) can't be stored. Custom services ("Add a provider") are stored only. The relay never routes to them.
- **How the relay picks them up.** `lib/relay/config.ts` reads `process.env` on every request, so the store writes to `process.env` directly:
  - At server start, `instrumentation.ts` calls `initCredentials()`. It loads the file and sets each stored variable in `process.env`. Stored values win over `.env`.
  - Every write through the API updates `process.env` straight away.
  - The value a variable had before is remembered. Clearing a stored key restores it, or removes the variable if it wasn't set.
  - Every 2 s, the stored values are re-applied if something reset the environment, for example the dev server reloading `.env` files. The reset value becomes the new original.
  - `/api/relay/status` → `configured` and the attestation statement therefore reflect stored keys with no other code changes.
- **A file that can't be opened is never overwritten.** This covers a wrong `RELAY_SECRET` and a damaged file. In that case nothing is applied, `GET` reports `storeError`, and writes get 503 until you restore the secret or file, or move the file aside and restart.
- **Single process.** The store and the sign-in nonces live in one server process, just like the spend meter.

### Owner sign-in ("owner signs")

1. `GET /api/relay/credentials/nonce?address=0x…` returns a one-time nonce (kept in memory for 5 minutes) and the exact EIP-4361 (Sign-In with Ethereum) message for this host, root and address. Its domain is the host the browser addressed (so a page on `127.0.0.1:3000` isn't asked to sign for `localhost:3000`, which wallets flag), but only when that host is this relay (its own origin or `RELAY_PUBLIC_URL`, with local aliases); any other `Host` gets the relay's own. The server keeps the message it issued.
2. The wallet signs the message with `personal_sign`.
3. `POST /api/relay/credentials/session {address, message, signature}`: the server consumes the nonce (single use) and checks that the message is byte-for-byte the one it issued for that address. It then verifies the signature (EOA locally; smart-contract wallets through ERC-1271/6492 on Sepolia). Finally it reads the root on-chain: the address must own `RELAY_ROOT_NAME`, and must also equal `RELAY_ROOT_OWNER` when that is set.
4. The server sets the cookie `relay_owner=<address>.<expiresAt>.<hmac>`: HttpOnly, `SameSite=Strict`, `Path=/api/relay/credentials`, 12 h, and `Secure` on https. The HMAC key is derived from `RELAY_SECRET` and covers the root name, address and expiry. Changing either the secret or the root ends every session.

The relay admin (`RELAY_ADMIN_TOKEN` as `Authorization: Bearer`, or the cookie from `/api/relay/admin`) may do everything the owner can.

## API

All routes run on Node.js, are dynamic and send `cache-control: no-store`. Errors use the relay's usual body `{ "error": string, "reason"?: string }`. Times are milliseconds since the epoch unless noted. No response ever contains a secret value.

| Route | Request | 200 response | Errors |
|---|---|---|---|
| `GET /api/relay/credentials` | (cookie optional) | `CredentialsResponse` | — |
| `GET /api/relay/credentials/nonce?address=0x…` | | `{ nonce, message, expiresAt }` | 400 bad address, 429 too many (20 per client, then 1 every 2 s), 503 no/short `RELAY_SECRET` or no root |
| `POST /api/relay/credentials/session` | `{address, message, signature}` | `{ owner: {address, expiresAt} }` + `Set-Cookie` | 400 malformed, 401 expired/used nonce, changed message, bad signature, not the owner or `RELAY_ROOT_OWNER` mismatch, 403/415 CSRF, 429 failure budget, 502 ENS read failed, 503 no secret or root |
| `POST /api/relay/credentials/session` | `{"action":"signout"}` | `{ owner: null }` + cookie cleared | 403/415 CSRF |
| `PUT /api/relay/credentials/keys/<ENV>` | `{"value": string \| null}` (`null`/`""` clears) | `CredentialKeyView` | 400 bad value, 401 not signed in, 403 CSRF or root changed hands, 404 not a storable variable, 415 not JSON, 502, 503 |
| `DELETE /api/relay/credentials/keys/<ENV>` | (no body) | `CredentialKeyView` | as above |
| `PUT /api/relay/credentials/custom` (or `POST`) | `{label, value?, note?}` | **201** `CustomServiceView` | 400, 401, 403, 415, 503 |
| `PUT /api/relay/credentials/custom/<id>` | `{label?, value?, note?}` (left out = kept; `value: null`/`""` clears) | `CustomServiceView` | 400, 401, 403, 404, 415, 503 |
| `DELETE /api/relay/credentials/custom/<id>` | (no body) | `CustomServiceView & {deleted: true}` (`set: false`) | 401, 403, 404, 415, 503 |
| `GET /api/relay/attestation?nonce=<hex>` | nonce optional, 1–32 bytes | `AttestationResponse` | 400 bad nonce, 429 (nonce requests), 503 `{error, reason:"no-tee", hint, detail}` |

Types live in `lib/relay/credentials-types.ts` and `lib/relay/attestation-core.ts`. Both are browser-safe.

```ts
CredentialsResponse = { owner: {address, expiresAt} | null, admin: boolean, secretConfigured: boolean,
  root: string | null, storeError: string | null, keys: CredentialKeyView[], custom: CustomServiceView[] }
CredentialKeyView = { env, label, apis: string[], secret: boolean, kind: "key" | "upstream", placeholder,
  set: boolean, source: "store" | "env" | null, updatedAt: number | null,
  hint: string | null /* owner/admin only */, value?: string /* non-secret slots, owner/admin only */ }
CustomServiceView = { id, label, set, updatedAt, hint: string | null, note?: string | null /* owner/admin */ }
```

**Writes.** You need the owner cookie or the admin. When a **cookie** authenticates the request (owner or admin cookie), it must also:

- send `content-type: application/json`, **including on DELETE**;
- send an `Origin` equal to the request's own origin or `RELAY_PUBLIC_URL` (localhost, 127.0.0.1 and [::1] count as the same);
- not send `sec-fetch-site: cross-site`.

The same CSRF checks apply to `POST /session`. Owner writes re-check on-chain that the wallet still owns the root. If it doesn't, the answer is 403 and the cookie is cleared. Admin requests with a bearer token skip the CSRF checks, since no cookie is involved. Failed sign-ins spend the relay's shared failure budget (`lib/relay/ratelimit.ts`).

**Hints.** For a value of 20 or more characters that starts with a recognizable prefix (`sk-proj-…`, `ghp_…`), the hint is the first 4 characters, `••••••••` and the last 4, e.g. `sk-p••••••••3f2a`. Values of 12–19 characters get `••••••••` and the last 4. Shorter values get `••••` and the last 2. Anonymous callers see only `set`, `source` and `updatedAt`.

## Attestation

`GET /api/relay/attestation` builds this statement (no secrets):

```json
{ "v": 1, "relay": "<RELAY_PUBLIC_URL>/api/relay", "root": "acme.eth", "rootOwner": "<RELAY_ROOT_OWNER or null>",
  "services": [{ "id": "claude", "configured": false }, …every catalog API…],
  "build": "<RELAY_BUILD_ID or null>", "issuedAt": "<ISO 8601>", "nonce": "<hex or null>" }
```

- **Canonical JSON:** keys are sorted, undefined members are dropped and there is no whitespace. `statementHash = sha256(canonical JSON)`.
- **Report data:** `reportData = statementHash ‖ nonce`, zero-padded to 32 bytes, 64 bytes in all.
- **Quote:** the relay passes `reportData` to `DstackClient.getQuote` and allows 5 s.
- **Response:** `{ statement, statementHash, reportData, quote, eventLog, source, info?, verifyUrl, measurements }`. Hex is lowercase without `0x`. `measurements` is `{version, teeType, mrSeam, mrtd, rtmr0…rtmr3, tdAttributes, xfam, reportData}`, parsed from a TDX quote v4 or v5, or `null`. `info` is a non-secret subset of dstack `info()`.
- **Checking the binding:** `checkBinding(statement, quote)` in `attestation-core.ts` recomputes the hash and compares it with the quote's REPORTDATA. The UI uses it to show "Statement bound to quote".
- **`source`:** `"simulator"` when `DSTACK_SIMULATOR_ENDPOINT` is set, else `"tee"` (the CVM socket `/var/run/dstack.sock`).
- **Caching and limits:** calls without a nonce are cached for 30 s and share one request in flight. Calls with a nonce are rate limited to 10 per client, then 1 every 5 s.
- **Verifying:** `verifyUrl` is `https://proof.t16z.com/`, Phala's TEE Attestation Explorer. You paste the quote hex or upload the binary there. It has no documented submit-by-URL API, so the relay only links to it. Verified reports get a shareable `/reports/<hash>` page.

### Running Phala's dstack simulator

The relay can run on a normal server. The simulator answers dstack's API with TDX-shaped quotes, so the flow works end to end, but **a simulator quote proves nothing about hardware**. The UI labels it "dstack simulator". Its quotes are not signed by real TDX hardware for this report data, so don't expect the explorer to accept them as genuine.

```bash
# Option A: Phala Cloud CLI (serves http://localhost:8090)
npx phala simulator start
echo 'DSTACK_SIMULATOR_ENDPOINT=http://localhost:8090' >> .env.local

# Option B: build from source (serves a Unix socket)
git clone https://github.com/Dstack-TEE/dstack.git && cd dstack/sdk/simulator
./build.sh && ./dstack-simulator
echo "DSTACK_SIMULATOR_ENDPOINT=$PWD/dstack.sock" >> /path/to/relay/.env.local
```

Restart the relay, then `curl -s localhost:3000/api/relay/attestation | jq .source` should print `"simulator"`. If the relay is deployed in a real dstack CVM (Phala Cloud), leave `DSTACK_SIMULATOR_ENDPOINT` unset.

## Security notes

- `RELAY_SECRET` must be 32+ characters (`openssl rand -hex 32`). Without it, sign-in and writes answer 503 with the reason. Keep it out of the data directory's backups, or the backups hold both lock and key.
- **Values are checked.** They must be visible ASCII with no spaces, because they go into HTTP headers. Line breaks and control characters are refused. The maximum length is 4096.
- **Secrets are never returned or logged:** not in responses, errors or logs. Startup logs only the number of stored keys.
- **All comparisons are constant-time:** cookie MACs and the issued-vs-signed message.
- **Stored keys are write-only.** Nobody can read a stored key back through the relay, including the owner. The owner can overwrite or clear it.
- **Attestation is only as strong as the TEE.** The statement is only meaningful from a real TEE (`source: "tee"`). With the simulator, it demonstrates the flow only.
