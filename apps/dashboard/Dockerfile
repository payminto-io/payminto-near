# syntax=docker/dockerfile:1.7
# Payminto operator dashboard (Next.js standalone). Build from the repository root:
#   docker build -f apps/dashboard/Dockerfile --build-arg NEXT_PUBLIC_NODE_URL=https://node.example.com -t payminto/dashboard .
# NEXT_PUBLIC_NODE_URL is compiled into the browser bundle: it is the node URL as the operator's browser sees it.

ARG NODE_VERSION=22.23.4

# Every workspace manifest, found rather than listed, so a new package can never be left out of the install.
FROM node:${NODE_VERSION}-bookworm-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
 && find . -name package.json -not -path "*/node_modules/*" -print0 | tar --null -cf - -T - | tar -xf - -C /manifests

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY --from=manifests /manifests/ ./
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "dashboard..."
# The sources of every shared package (the dashboard imports several of them) and of the dashboard itself.
COPY packages packages
COPY apps/dashboard apps/dashboard
ARG NEXT_PUBLIC_NODE_URL=http://localhost:8787
ENV NEXT_PUBLIC_NODE_URL=${NEXT_PUBLIC_NODE_URL} NEXT_OUTPUT=standalone
RUN pnpm --filter dashboard build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/dashboard/server.js"]
