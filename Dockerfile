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
# The rule still applies to the unpinned `supergateway` install below.
COPY .npmrc package*.json ./
RUN NPM_CONFIG_MIN_RELEASE_AGE=0 npm ci --no-audit --no-fund

COPY src/ ./src/
COPY tsconfig.json tsdown.config.ts ./
RUN npm run build

# Install supergateway plus our just-built package. We pack first because
# `npm install -g .` symlinks /usr/local/lib/node_modules/coaching-mcp into
# /build, which dangles in the final stage. Installing from the tarball
# extracts a real directory under /usr/local/lib/node_modules instead.
RUN npm pack && npm install -g --no-audit --no-fund ./coaching-mcp-*.tgz supergateway

# Verify builder-stage layout: bin entries are symlinks, dist/ is a real file,
# shebang is preserved, node is v26.
RUN test -L /usr/local/bin/coaching-mcp \
 && test -L /usr/local/bin/supergateway \
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
# arguments are dereferenced). This keeps `coaching-mcp` and `supergateway`
# as real symlinks into /usr/local/lib/node_modules — without that, Node's
# ESM resolver starts from /usr/local/bin/ and fails with ERR_MODULE_NOT_FOUND
# (e.g. supergateway → "Cannot find package 'yargs'").
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin /usr/local/bin

# Re-verify in the FINAL image — the builder-stage checks passed even though
# the multi-stage COPY was breaking the layout, so we have to check here too.
RUN test -L /usr/local/bin/coaching-mcp \
 && test -L /usr/local/bin/supergateway \
 && test -f /usr/local/lib/node_modules/coaching-mcp/dist/index.js \
 && test -f /usr/local/lib/node_modules/supergateway/package.json \
 && head -1 /usr/local/lib/node_modules/coaching-mcp/dist/index.js | grep -q '^#!/usr/bin/env node$' \
 && node --version | grep -q '^v26\.'

# /data  — SQLite database (persistent volume, survives restarts)
# /seed  — read-only seed data mounted at runtime
VOLUME ["/data", "/seed"]
ENV DATA_DIR=/data \
    SEED_DIR=/seed

USER nonroot
WORKDIR /home/nonroot

EXPOSE 8000
CMD ["supergateway", "--stdio", "coaching-mcp", "--outputTransport", "streamableHttp", "--port", "8000"]
