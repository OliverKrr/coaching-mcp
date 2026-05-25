FROM node:26-trixie-slim AS builder

# Build tools for better-sqlite3 native module on arm64 (Pi 4 / aarch64).
# These stay in the builder stage only — final image does not ship a toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# .npmrc pins min-release-age=7 — supply-chain protection that gates dep
# UPDATES on the developer machine. The lockfile we ship is already trusted
# (reviewed, committed), so bypass min-release-age for `npm ci` here.
# The rule still applies to the unpinned `supergateway` install below.
COPY .npmrc package*.json ./
RUN NPM_CONFIG_MIN_RELEASE_AGE=0 npm ci --no-audit --no-fund

COPY src/ ./src/
COPY tsconfig.json tsdown.config.ts ./
RUN npm run build

# Install the built package globally so the `coaching-mcp` binary resolves,
# plus the stdio→Streamable HTTP bridge.
RUN npm install -g --no-audit --no-fund . supergateway


FROM node:26-trixie-slim

RUN groupadd --system --gid 999 nonroot \
 && useradd --system --gid 999 --uid 999 --create-home nonroot \
 && mkdir -p /data /seed \
 && chown nonroot:nonroot /data /seed

COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin/coaching-mcp /usr/local/bin/coaching-mcp
COPY --from=builder /usr/local/bin/supergateway /usr/local/bin/supergateway

# /data  — SQLite database (persistent volume, survives restarts)
# /seed  — read-only seed data mounted at runtime
VOLUME ["/data", "/seed"]
ENV DATA_DIR=/data \
    SEED_DIR=/seed

USER nonroot
WORKDIR /home/nonroot

EXPOSE 8000
CMD ["supergateway", "--stdio", "coaching-mcp", "--outputTransport", "streamableHttp", "--port", "8000"]
