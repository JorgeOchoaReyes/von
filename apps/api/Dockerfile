# The control plane.
#
# Node 22 because every package runs TypeScript directly under
# --experimental-strip-types; there is no build step to produce JS.
FROM node:22-slim

# git is not optional here: the agent's workspace is a real checkout, and every
# preview and publish shells out to it. A missing git surfaces as "the agent
# can't edit anything", far from its cause.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /srv

# Manifests first, so a change to source code does not re-resolve the whole
# dependency graph on every deploy.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/agent/package.json ./packages/agent/
COPY packages/core/package.json ./packages/core/
COPY packages/generator/package.json ./packages/generator/
COPY packages/preview/package.json ./packages/preview/
COPY packages/provisioning/package.json ./packages/provisioning/
COPY packages/release/package.json ./packages/release/
COPY packages/store/package.json ./packages/store/

# Only what the control plane needs. The Expo client and the Next.js console are
# deployed separately and would drag a large native toolchain in here.
RUN pnpm install --frozen-lockfile --filter @von/api...

COPY apps/api ./apps/api
COPY packages ./packages
COPY templates ./templates

ENV NODE_ENV=production
# Cloud Run supplies PORT; this is the default for anything that does not.
ENV PORT=8787
EXPOSE 8787

# Run as a non-root user: this process clones customer repositories and executes
# a package manager inside them.
RUN chown -R node:node /srv
USER node

CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
