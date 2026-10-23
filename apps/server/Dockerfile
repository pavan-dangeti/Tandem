FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tandem/server build
# the bundle needs only runtime dependencies; dev tooling stays out of the image
RUN CI=true pnpm install --frozen-lockfile --prod

FROM node:22-alpine
WORKDIR /app
# The runtime only runs node; npm and corepack would just add attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]