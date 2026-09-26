# Deploying the relay (home server)

Follows Derek's server runbook: Docker Compose behind Traefik and Cloudflare Tunnel, no host ports.

| | |
|---|---|
| Project directory | `/srv/projects/relay` (contents replaced by `deploy/deploy.sh`, except `.env`) |
| Domain | `relay.derek2403.win` (web UI, relay API, `/install`) → Cloudflare Tunnel → `http://localhost:8080` (Traefik) |
| Container | `relay-backend`, listens on `0.0.0.0:3000`, joins `proxy` only; Traefik router/service `relay-backend` |
| Persistent data | `/mnt/Storage1/app-data/relay/data` → `/data` (spend meter, decision log, encrypted credentials) |
| Database | none |
| Health check | `GET /api/relay/status` inside the container |
| Replicas | exactly one (the meter file must not be shared) |

## Secrets

`/srv/projects/relay/.env` (mode 600, never committed): `APP_DOMAIN`, `RELAY_PUBLIC_URL`, `RELAY_ROOT_NAME`,
`RELAY_ROOT_OWNER`, `RELAY_RPC_URL`, `RELAY_LOGS_RPC_URL`, `NEXT_PUBLIC_SEPOLIA_RPC_URL`, `OPENAI_API_KEY`,
`RELAY_ADMIN_TOKEN`, `RELAY_SECRET`, `FUNDER_PRIVATE_KEY`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
`NEXT_PUBLIC_*` values are build args (they end up in the browser bundle); everything else is read at runtime.

## Update

Mac, from the repo: commit, then `deploy/deploy.sh`. It ships `git archive HEAD` plus a lockfile synced to it,
runs `docker compose config --quiet` and `docker compose up -d --build` on the server.

Verify (Server): `docker compose ps`, `docker compose logs --tail=100`,
`curl -i -H 'Host: relay.derek2403.win' http://127.0.0.1:8080/api/relay/status`.

## Backup and restore

Back up `/mnt/Storage1/app-data/relay/data` (stop the container first for a consistent copy) to
`/mnt/Storage1/backups/relay/<date>`, plus `.env` through an encrypted method. Restore: copy the folder back,
same `RELAY_SECRET` (it decrypts `credentials.json`), `docker compose up -d`. Everything else lives on ENS.

## Rollback

Check out the previous commit on the Mac and run `deploy/deploy.sh` again.
