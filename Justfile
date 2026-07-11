default:
    @just --list

build:
    npm run build

dev:
    npm run dev

# Run the multi-user HTTP server locally (requires PUBLIC_URL / OIDC_* / ALLOWED_EMAILS env)
serve:
    npx tsx src/index.ts serve

test:
    npm test

check:
    npm run check

fix:
    npm run check:fix

types:
    npm run check:types

# Upgrade all deps to latest then reinstall
update-deps:
    npx npm-check-updates -u
    npm install

# Build Docker image locally (native arch)
docker-build:
    docker build -t coaching-mcp .

# Build for arm64 (Raspberry Pi 4 / aarch64)
docker-build-arm64:
    docker buildx build --platform linux/arm64 -t coaching-mcp:arm64 .

# Snapshot the local SQLite DB: lossless skill.db (recovery) + readable markdown incl. journal
snapshot dest="snapshots": build
    node dist/snapshot-cli.js {{dest}}

# Release X.Y.Z: version stamp, quality gate, commit, tag, push, GitHub release (see RELEASING.md)
release version:
    #!/usr/bin/env bash
    set -euo pipefail
    v="{{version}}"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: just release X.Y.Z" >&2; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "abort: working tree not clean" >&2; exit 1; }
    [ "$(git branch --show-current)" = "main" ] || { echo "abort: not on main" >&2; exit 1; }
    git fetch origin main
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "abort: main is not in sync with origin/main" >&2; exit 1; }
    git rev-parse "v$v" >/dev/null 2>&1 && { echo "abort: tag v$v already exists" >&2; exit 1; }
    npm pkg set version="$v"
    npm install --package-lock-only --no-audit --no-fund >/dev/null
    node -e 'const fs=require("fs");const p="src/version.ts";const v=process.argv[1];const s=fs.readFileSync(p,"utf8").replace(/export const VERSION = "[^"]+"/, `export const VERSION = "${v}"`);fs.writeFileSync(p,s);' "$v"
    grep -q "\"$v\"" src/version.ts || { echo "abort: src/version.ts stamp failed" >&2; exit 1; }
    npm run check && npm run check:types && npm test && npm run build
    git add package.json package-lock.json src/version.ts
    git diff --cached --quiet || git commit -m "release: v$v"
    git tag -a "v$v" -m "coaching-mcp v$v"
    git push origin main --follow-tags
    gh release create "v$v" --generate-notes
    echo "Released v$v"
