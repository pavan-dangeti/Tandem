FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter web...
# The API origin is baked into the bundle and its content security policy.
ARG VITE_API
RUN test -n "$VITE_API" && VITE_API=$VITE_API pnpm --filter web exec vite build

FROM caddy:2.8.4-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
