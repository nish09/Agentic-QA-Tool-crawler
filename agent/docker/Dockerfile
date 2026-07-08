# Build context must be the project root (not agent/):
#   docker build -f agent/docker/Dockerfile .
# Or use docker-compose which sets this automatically.

FROM mcr.microsoft.com/playwright:v1.52.0-noble

# /project mirrors the repo root structure so relative imports resolve identically
# to local development.
WORKDIR /project

# Install agent dependencies (separate layer — only re-runs when package.json changes)
COPY agent/package*.json ./agent/
RUN cd agent && npm ci

# Copy shared utilities (needed by relative imports in agent/src)
COPY shared/ ./shared/

# Copy agent source
COPY agent/src/       ./agent/src/
COPY agent/tsconfig.json ./agent/

# Output directory (mounted as a volume in docker-compose)
RUN mkdir -p /output

WORKDIR /project/agent

ENV OUTPUT_DIR=/output
ENV NODE_ENV=production

ENTRYPOINT ["npx", "ts-node", "--transpile-only", "src/index.ts"]
