# syntax=docker/dockerfile:1
# Contexto de build = raiz do monorepo (necessário para pnpm workspaces).
# Buildado exclusivamente no GitHub Actions -> GHCR; NUNCA no droplet (EasyPanel só puxa a imagem).

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @aios-pocket/db run db:generate

FROM node:22-slim
RUN corepack enable
# openssl é exigido pela engine query do Prisma em runtime — sem ele o client emite o
# warning "Unable to require libssl" e, em algumas distros, falha ao conectar.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
# tsx em produção é decisão consciente desta fase (sem build step): o monorepo ainda não
# tem um passo de compilação para @aios-pocket/api. Evita duplicar a esteira de build só
# para esta fase do Plano B; revisitar (adicionar `tsc`/bundler) se o custo de runtime pesar.
CMD ["pnpm", "--filter", "@aios-pocket/api", "exec", "tsx", "src/server.ts"]
