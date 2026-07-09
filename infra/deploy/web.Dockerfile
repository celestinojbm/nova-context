# Nova web app — build from the repo root:
#   docker build -f infra/deploy/web.Dockerfile -t nova-web .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm exec turbo build --filter=@nova/web...
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@nova/web", "start"]
