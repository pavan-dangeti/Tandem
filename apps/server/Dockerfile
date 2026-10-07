FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/crdt ./packages/crdt
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tandem/server build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]