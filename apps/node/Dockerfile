# syntax=docker/dockerfile:1.7
# Payminto Clearing Node. Build from the repository root:
#   docker build -f apps/node/Dockerfile -t payminto/node .
# The node runs its TypeScript sources directly with Node's type stripping (22.18+), so there is no compile step.
# Workspace packages stay symlinked outside node_modules on purpose: Node does not strip types inside node_modules.

ARG NODE_VERSION=22.23.4

# Every workspace manifest, found rather than listed, so a new package can never be left out of the install.
FROM node:${NODE_VERSION}-bookworm-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
 && find . -name package.json -not -path "*/node_modules/*" -print0 | tar --null -cf - -T - | tar -xf - -C /manifests

FROM node:${NODE_VERSION}-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY --from=manifests /manifests/ ./
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter "@payminto/node..."
# The sources of every shared package (the node imports several of them) and of the node itself.
COPY packages packages
COPY apps/node apps/node

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/clearing.db \
    BACKUP_DIR=/data/backups
WORKDIR /app
COPY --from=deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/node ./apps/node
RUN mkdir -p /data \
 && chown -R node:node /data
USER node
WORKDIR /app/apps/node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
