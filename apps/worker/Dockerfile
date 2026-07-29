# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /workspace
COPY . .
# The Git-free build context cannot install repository hooks. Keep each bypass scoped to the two
# package lifecycle commands so dependency scripts still run and ordinary build steps do not inherit it.
RUN --mount=type=cache,id=reconai-pnpm-store,target=/pnpm/store,sharing=locked LEFTHOOK=0 pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/worker... build
RUN --mount=type=cache,id=reconai-pnpm-store,target=/pnpm/store,sharing=locked LEFTHOOK=0 pnpm --filter @workspace/worker deploy --prod --legacy /release

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ENV NODE_ENV=production
# Package managers are build-only authority. The runtime needs only the Node executable.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build --chown=node:node /release ./
USER node
CMD ["node", "dist/main.js"]
