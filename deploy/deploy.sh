#!/bin/sh
# Mac: deploys the committed tree to /srv/projects/relay on the home server and rebuilds it.
#
#   deploy/deploy.sh            # uses `ssh dereks-server`
#   DEPLOY_HOST=other deploy/deploy.sh
#
# Ships `git archive HEAD` plus this checkout's package-lock.json (untracked here, but it pins the
# server's `npm ci`). The server's .env is never touched: create it once (see deploy/README.md).
# rsync --delete keeps /srv/projects/relay identical to HEAD, apart from .env.
set -eu

host="${DEPLOY_HOST:-dereks-server}"
dir=/srv/projects/relay
root=$(git rev-parse --show-toplevel)

if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "Note: uncommitted changes are not deployed; shipping HEAD only." >&2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$root" archive HEAD | tar -x -C "$tmp"
cp "$root/package-lock.json" "$tmp/package-lock.json"
# Make the lockfile match HEAD's package.json exactly (versions stay as locked), so the server's `npm ci` accepts it.
(cd "$tmp" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --silent)

echo "Deploying $(git -C "$root" rev-parse --short HEAD) to $host:$dir"
rsync -az --delete --exclude .env "$tmp/" "$host:$dir/"
ssh "$host" "set -e; cd $dir; test -f .env || { echo 'Missing $dir/.env (see deploy/README.md)'; exit 1; }; docker compose config --quiet; docker compose up -d --build; docker compose ps"
