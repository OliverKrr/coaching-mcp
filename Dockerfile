FROM node:24-slim

# Build tools for better-sqlite3 native module on arm64 (Pi 4 / aarch64)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# stdio → Streamable HTTP bridge
RUN npm install -g supergateway

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Install globally so 'skill-mcp' binary is available to supergateway
RUN npm prune --omit=dev
RUN npm install -g .

# /data  — SQLite database (persistent volume, survives restarts)
# /seed  — read-only seed data mounted at runtime
VOLUME ["/data", "/seed"]
ENV DATA_DIR=/data
ENV SEED_DIR=/seed
EXPOSE 8000
CMD ["supergateway", "--stdio", "coaching-mcp", "--outputTransport", "streamableHttp", "--port", "8000"]
