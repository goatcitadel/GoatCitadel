FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

ARG GOATCITADEL_VITE_ALLOWED_HOSTS=""
ARG VITE_GATEWAY_ALLOWED_HOSTS=""
ARG VITE_GATEWAY_URL=""

ENV GOATCITADEL_VITE_ALLOWED_HOSTS=$GOATCITADEL_VITE_ALLOWED_HOSTS
ENV VITE_GATEWAY_ALLOWED_HOSTS=$VITE_GATEWAY_ALLOWED_HOSTS
ENV VITE_GATEWAY_URL=$VITE_GATEWAY_URL

WORKDIR /app

RUN corepack enable

COPY . .

RUN corepack prepare pnpm@10.31.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @goatcitadel/gateway-core... build
RUN pnpm config:sync
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ARG GOATCITADEL_UID=10001
ARG GOATCITADEL_GID=10001

ENV NODE_ENV=production
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=8787
ENV MISSION_CONTROL_HOST=0.0.0.0
ENV MISSION_CONTROL_PORT=4173

WORKDIR /app

RUN groupadd --gid "${GOATCITADEL_GID}" goatcitadel \
  && useradd --uid "${GOATCITADEL_UID}" --gid goatcitadel --create-home --home-dir /home/goatcitadel --shell /usr/sbin/nologin goatcitadel

COPY --from=builder --chown=goatcitadel:goatcitadel /app /app

RUN mkdir -p /app/data /app/workspace /app/.worktrees /app/.tmp \
  && chown -R goatcitadel:goatcitadel /app/data /app/workspace /app/.worktrees /app/.tmp /home/goatcitadel

USER goatcitadel

EXPOSE 4173 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.GATEWAY_PORT || '8787') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "scripts/docker-start.mjs"]
