# Nova enrichment worker — build from the repo root:
#   docker build -f infra/deploy/worker.Dockerfile -t nova-worker .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm exec turbo build --filter=@nova/worker...
ENV NODE_ENV=production
CMD ["node", "services/worker/dist/index.js"]
