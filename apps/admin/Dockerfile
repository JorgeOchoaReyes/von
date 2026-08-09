# Von's console.
#
# Two stages: the build needs the whole workspace, the runtime needs almost
# none of it. Next's standalone output is what makes that split possible.
FROM node:22-slim AS build

RUN corepack enable
WORKDIR /srv

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/admin/package.json ./apps/admin/
COPY packages/core/package.json ./packages/core/

RUN pnpm install --frozen-lockfile --filter @von/admin...

COPY apps/admin ./apps/admin
COPY packages/core ./packages/core

# NEXT_TELEMETRY_DISABLED because a build container phoning home is noise at
# best and an egress failure at worst.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @von/admin build

FROM node:22-slim AS runtime
WORKDIR /srv

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run supplies PORT; this is the default for anything that does not.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# The standalone output already contains the traced dependencies. Static assets
# are not traced into it and have to come across separately, or every page
# renders unstyled.
COPY --from=build --chown=node:node /srv/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /srv/apps/admin/.next/static ./apps/admin/.next/static

USER node

CMD ["node", "apps/admin/server.js"]
