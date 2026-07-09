# Nova API — build from the repo root:
#   docker build -f infra/deploy/api.Dockerfile -t nova-api .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm exec turbo build --filter=@nova/api...
ENV NODE_ENV=production
EXPOSE 3001
# Migrations run as the deploy release step (see fly.api.toml), not at boot.
CMD ["node", "services/api/dist/index.js"]
