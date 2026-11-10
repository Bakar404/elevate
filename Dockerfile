# One image for both processes: `web` (default) and `worker` (override the command).
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

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
