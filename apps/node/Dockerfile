# syntax=docker/dockerfile:1.7
# Payminto Clearing Node. Build from the repository root:
#   docker build -f apps/node/Dockerfile -t payminto/node .
# The node runs its TypeScript sources directly with Node's type stripping (22.18+), so there is no compile step.
# Workspace packages stay symlinked outside node_modules on purpose: Node does not strip types inside node_modules.

ARG NODE_VERSION=22.23.4

FROM node:${NODE_VERSION}-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
# Every workspace manifest, so the lockfile matches; only the node and its dependencies are installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk/package.json packages/sdk/
COPY packages/models/package.json packages/models/
COPY apps/node/package.json apps/node/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mcp/package.json apps/mcp/
COPY apps/demo/package.json apps/demo/
COPY apps/agent/package.json apps/agent/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter "@payminto/node..."

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/clearing.db \
    BACKUP_DIR=/data/backups \
    DEPLOYMENTS_DIR=/app/deployments
WORKDIR /app
COPY --from=deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=deps /app/packages/sdk/node_modules ./packages/sdk/node_modules
COPY --from=deps /app/packages/models/node_modules ./packages/models/node_modules
COPY --from=deps /app/apps/node/node_modules ./apps/node/node_modules
COPY packages/protocol/package.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY packages/sdk/package.json packages/sdk/
COPY packages/sdk/src packages/sdk/src
COPY packages/models/package.json packages/models/
COPY packages/models/src packages/models/src
COPY apps/node/package.json apps/node/
COPY apps/node/src apps/node/src
COPY apps/node/migrations apps/node/migrations
COPY apps/node/scripts apps/node/scripts
# Live deployments (133.json, 177.json) ship with the image. The local anvil deployment is written at runtime by the
# compose `local` profile into a volume mounted at /app/deployments-local, which this symlink points at.
COPY contracts/deployments/ deployments/
RUN mkdir -p /data /app/deployments-local \
 && ln -sfn /app/deployments-local/31337.json /app/deployments/31337.json \
 && chown -R node:node /data /app/deployments-local
USER node
WORKDIR /app/apps/node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
