default:
    @just --list

build:
    npm run build

dev:
    npm run dev

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
    docker build -t skill-mcp .

# Build for arm64 (Raspberry Pi 4 / aarch64)
docker-build-arm64:
    docker buildx build --platform linux/arm64 -t skill-mcp:arm64 .
