FROM node:26-trixie-slim AS builder

# Build tools for better-sqlite3 native module on arm64 (Pi 4 / aarch64).
# These stay in the builder stage only — final image does not ship a toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# .npmrc pins min-release-age=7 — supply-chain protection that gates dep
# UPDATES on the developer machine. The lockfile we ship is already trusted
# (reviewed, committed), so bypass min-release-age for `npm ci` here.
COPY .npmrc package*.json ./
RUN NPM_CONFIG_MIN_RELEASE_AGE=0 npm ci --no-audit --no-fund

COPY src/ ./src/
COPY seed-template/ ./seed-template/
COPY tsconfig.json tsdown.config.ts ./
RUN npm run build

# Install our just-built package. We pack first because `npm install -g .`
# symlinks /usr/local/lib/node_modules/coaching-mcp into /build, which dangles
# in the final stage. Installing from the tarball extracts a real directory
# under /usr/local/lib/node_modules instead.
RUN npm pack && npm install -g --no-audit --no-fund ./coaching-mcp-*.tgz

# Verify builder-stage layout: bin entries are symlinks, dist/ is a real file,
# shebang is preserved, node is v26.
RUN test -L /usr/local/bin/coaching-mcp \
 && test -f /usr/local/lib/node_modules/coaching-mcp/dist/index.js \
 && head -1 /usr/local/lib/node_modules/coaching-mcp/dist/index.js | grep -q '^#!/usr/bin/env node$' \
 && node --version | grep -q '^v26\.'


FROM node:26-trixie-slim

RUN groupadd --system --gid 999 nonroot \
 && useradd --system --gid 999 --uid 999 --create-home nonroot \
 && mkdir -p /data /seed \
 && chown nonroot:nonroot /data /seed

# Copy the WHOLE bin/ and lib/node_modules directories. Docker COPY preserves
# symlinks that are nested inside a directory source (only top-level symlink
# arguments are dereferenced). This keeps `coaching-mcp` a real symlink into
# /usr/local/lib/node_modules — without that, Node's ESM resolver starts from
# /usr/local/bin/ and fails with ERR_MODULE_NOT_FOUND.
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin /usr/local/bin

# Re-verify in the FINAL image — the builder-stage checks passed even though
# the multi-stage COPY was breaking the layout, so we have to check here too.
RUN test -L /usr/local/bin/coaching-mcp \
 && test -f /usr/local/lib/node_modules/coaching-mcp/dist/index.js \
 && head -1 /usr/local/lib/node_modules/coaching-mcp/dist/index.js | grep -q '^#!/usr/bin/env node$' \
 && node --version | grep -q '^v26\.'

# Generic seed template baked in as the default /seed content. A bind mount of
# personal seed data replaces it; without a mount, first start seeds the DB with
# the template (placeholders + onboarding interview for the connected assistant).
COPY --chown=nonroot:nonroot seed-template/ /seed/

# /data — SQLite database (persistent volume, survives restarts).
# /seed is deliberately NOT declared as a volume: a VOLUME directive would make
# Docker snapshot it into an anonymous volume on first container creation and
# keep serving that stale copy across every later image rebuild (topic packs
# and template updates would silently never arrive). Operators who want their
# own seed bind-mount over /seed; everyone else gets the current baked-in copy.
VOLUME ["/data"]
ENV DATA_DIR=/data \
    SEED_DIR=/seed

USER nonroot
WORKDIR /home/nonroot

EXPOSE 8000
# Multi-user HTTP mode (Streamable HTTP MCP + built-in OAuth + account page).
# For the single-user stdio server, override the command with ["coaching-mcp"].
CMD ["coaching-mcp", "serve"]
