# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:26.6.0-bookworm-slim@sha256:81502e860176e63695d769d3d1a2d3a403abc1c27c6a02169b765f3e43b60ede AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /workspace
COPY . .
# The Git-free build context cannot install repository hooks. Keep each bypass scoped to the two
# package lifecycle commands so dependency scripts still run and ordinary build steps do not inherit it.
RUN --mount=type=cache,id=reconai-pnpm-store,target=/pnpm/store,sharing=locked LEFTHOOK=0 pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api... build
RUN --mount=type=cache,id=reconai-pnpm-store,target=/pnpm/store,sharing=locked LEFTHOOK=0 pnpm --filter @workspace/api deploy --prod --legacy /release

FROM node:26.6.0-bookworm-slim@sha256:81502e860176e63695d769d3d1a2d3a403abc1c27c6a02169b765f3e43b60ede AS runtime
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
# Package managers are build-only authority. The runtime needs only the Node executable.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build --chown=node:node /release ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
