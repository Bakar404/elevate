# One image for both processes: `web` (default) and `worker` (override the command).
FROM node:24-bookworm-slim AS base
# Override when npmjs is unreachable (e.g. behind a corporate proxy): --build-arg NPM_REGISTRY=...
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=$NPM_REGISTRY pnpm_config_registry=$NPM_REGISTRY NEXT_TELEMETRY_DISABLED=1
RUN echo "registry=$NPM_REGISTRY" > /root/.npmrc
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @elevate/web build

FROM base AS runtime
ENV NODE_ENV=production ELEVATE_DATA_DIR=/data
COPY --from=build /app /app
RUN mkdir -p /data
VOLUME /data
EXPOSE 3100
CMD ["pnpm", "start"]