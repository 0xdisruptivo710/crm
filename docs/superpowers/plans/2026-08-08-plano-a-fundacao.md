# Aios Pocket — Plano A: Fundação do Monorepo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fundação executável da Fatia 0: monorepo pnpm+Turborepo com contracts Zod, banco Prisma multi-tenant com TenantContext, enforcement mecânico, esqueleto Fastify com auth Supabase, fila BullMQ com eventos idempotentes, seed do piloto e CI verde.

**Architecture:** Monorepo com packages compartilhados (`contracts`, `db`) consumidos por `apps/api` (Fastify + workers BullMQ num único processo). Tenancy por aplicação: Prisma client extension injeta `company_id` via AsyncLocalStorage; acesso a dados só por repositories. Spec: `docs/superpowers/specs/2026-08-08-fatia-0-design.md`.

**Tech Stack:** pnpm 10 workspaces, Turborepo 2, TypeScript 5 strict, Zod 4, Prisma 6, Fastify 5, BullMQ 5 + ioredis, jose (JWT Supabase), Vitest 3, ESLint 9 flat + typescript-eslint 8, GitHub Actions, Docker (Postgres 16 + Redis 7 locais).

**Divisão da entrega (spec → 4 planos):** Plano A (este) = fundação. Plano B = providers/webhooks/envio Evolution + fixtures ao vivo. Plano C = inbox realtime (`apps/web`) + critério ponta-a-ponta. Plano D = ZApiProvider na mesma suíte + docs/ADRs finais. Os planos B–D serão escritos quando o anterior estiver verde.

## Global Constraints

- TypeScript `strict: true` em todos os packages; `any` proibido (lint error).
- Import de `@prisma/client` fora de `packages/db` proibido; literais de hosts Evolution/Z-API fora de `packages/providers` proibidos (ESLint).
- Toda tabela de negócio tem `company_id`; whitelist de exceções contém apenas `Company` (é o próprio tenant). `raw_webhook_events` tem `company_id` nullable, mas TEM a coluna.
- Identificadores em inglês; comentários, docs e mensagens de commit em português.
- Segredos só no `.env` (gitignored, já existe na raiz com credenciais reais); `.env.example` sem valores. Scripts standalone NÃO carregam `.env` sozinhos — sempre `dotenv -e ../../.env --` (dotenv-cli) nos scripts de package.
- Node >= 22, pnpm 10. Se um pin de versão falhar no install, usar a estável mais próxima e registrar no commit.
- Rotas HTTP nunca esperam provider; eventos publicados após o commit; consumers idempotentes; `correlation_id` em toda mensagem/evento.
- Antes de cada commit: rodar os testes do package tocado. Commits pequenos, prefixos `feat:`/`test:`/`chore:`.
- Trabalhar na raiz do repo `aios-pocket` (git já iniciado, branch `master`).

---

### Task 1: Scaffold do monorepo + infra local Docker

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `docker-compose.yml`

**Interfaces:**
- Produces: workspace pnpm com globs `apps/*` e `packages/*`; `tsconfig.base.json` que todos os packages estendem; Postgres local em `localhost:55432` (user `postgres`, senha `postgres`, db `aios_pocket`) e Redis em `localhost:6379` — os mesmos endereços já referenciados no `.env`.

- [ ] **Step 1: Criar os arquivos de raiz**

`package.json`:
```json
{
  "name": "aios-pocket",
  "private": true,
  "packageManager": "pnpm@10.4.1",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "lint": "eslint .",
    "test:arch": "vitest run tests/architecture"
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.7.2"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "cache": false, "persistent": true },
    "typecheck": { "dependsOn": ["^typecheck"] },
    "test": { "dependsOn": [] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: aios_pocket
    ports:
      - "55432:5432"
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

- [ ] **Step 2: Instalar e validar workspace**

Run: `pnpm install`
Expected: cria `pnpm-lock.yaml` sem erros (workspace ainda sem packages internos — ok).

- [ ] **Step 3: Subir a infra local**

Run: `docker compose up -d` e depois `docker compose ps`
Expected: `postgres` e `redis` com status `running`. (Docker Desktop precisa estar aberto no Windows.)

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json docker-compose.yml pnpm-lock.yaml
git commit -m "chore: scaffold do monorepo (pnpm + turborepo) e infra local docker"
```

---

### Task 2: `packages/contracts` — schemas Zod dos tipos normalizados e eventos

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`, `packages/contracts/src/webhooks.ts`, `packages/contracts/src/events.ts`
- Test: `packages/contracts/test/webhooks.test.ts`, `packages/contracts/test/events.test.ts`

**Interfaces:**
- Produces (consumidos por Planos B/C e Tasks 6–8):
  - `providerSchema` (`'evolution' | 'zapi'`), `messageStateSchema` (7 estados), `messageTypeSchema`
  - `incomingMessageSchema`, `messageStatusUpdateSchema`, `connectionStatusChangeSchema`, `normalizedWebhookEventSchema` (discriminated union em `kind`) e os tipos inferidos `IncomingMessage`, `MessageStatusUpdate`, `ConnectionStatusChange`, `NormalizedWebhookEvent`
  - `domainEventSchema` e tipo `DomainEvent` (`{ name, companyId, correlationId, schemaVersion, occurredAt, payload }`)

- [ ] **Step 1: Criar package e escrever os testes que falham**

`packages/contracts/package.json`:
```json
{
  "name": "@aios-pocket/contracts",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": { "vitest": "^3.0.0" }
}
```

`packages/contracts/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/contracts/test/webhooks.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { incomingMessageSchema, normalizedWebhookEventSchema } from '../src/index.js'

const validIncoming = {
  kind: 'incoming_message',
  provider: 'evolution',
  providerMessageId: 'ABC123',
  phone: '+5511999990000',
  conversationExternalId: '5511999990000@s.whatsapp.net',
  fromMe: false,
  type: 'text',
  text: 'olá',
  media: null,
  replyToProviderMessageId: null,
  isEdit: false,
  timestamp: '2026-08-08T12:00:00.000Z',
  metadata: {},
}

describe('incomingMessageSchema', () => {
  it('aceita mensagem válida e coage timestamp para Date', () => {
    const parsed = incomingMessageSchema.parse(validIncoming)
    expect(parsed.timestamp).toBeInstanceOf(Date)
    expect(parsed.fromMe).toBe(false)
  })

  it('rejeita mensagem sem fromMe (campo aprendido em produção — obrigatório)', () => {
    const { fromMe: _omitted, ...semFromMe } = validIncoming
    expect(incomingMessageSchema.safeParse(semFromMe).success).toBe(false)
  })
})

describe('normalizedWebhookEventSchema', () => {
  it('discrimina pelos três kinds internos', () => {
    const status = normalizedWebhookEventSchema.parse({
      kind: 'message_status_update',
      provider: 'zapi',
      providerMessageId: 'ABC123',
      status: 'delivered',
      timestamp: '2026-08-08T12:00:01.000Z',
    })
    expect(status.kind).toBe('message_status_update')
    const conn = normalizedWebhookEventSchema.parse({
      kind: 'connection_status_change',
      provider: 'evolution',
      status: 'disconnected',
      reason: 'qr expirado',
      timestamp: '2026-08-08T12:00:02.000Z',
    })
    expect(conn.kind).toBe('connection_status_change')
  })
})
```

`packages/contracts/test/events.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { domainEventSchema } from '../src/index.js'

describe('domainEventSchema', () => {
  it('exige correlationId e schemaVersion desde o evento nº 1', () => {
    const ok = domainEventSchema.parse({
      name: 'MessageReceived',
      companyId: '3b241101-e2bb-4255-8caf-4136c566a962',
      correlationId: '9f8b8a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
      schemaVersion: 1,
      occurredAt: '2026-08-08T12:00:00.000Z',
      payload: { messageId: 'abc' },
    })
    expect(ok.occurredAt).toBeInstanceOf(Date)
    expect(domainEventSchema.safeParse({ name: 'X', payload: {} }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm install` (na raiz, para linkar o package novo) e `pnpm --filter @aios-pocket/contracts test`
Expected: FAIL — `Cannot find module '../src/index.js'` (ou equivalente).

- [ ] **Step 3: Implementar os schemas**

`packages/contracts/src/webhooks.ts`:
```ts
import { z } from 'zod'

// União normalizada de webhooks (ADR-0003): todo payload de provider vira um destes três tipos.
export const providerSchema = z.enum(['evolution', 'zapi'])
export const messageStateSchema = z.enum(['received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed'])
export const messageTypeSchema = z.enum(['text', 'image', 'audio', 'video', 'document', 'sticker', 'unknown'])

export const incomingMessageSchema = z.object({
  kind: z.literal('incoming_message'),
  provider: providerSchema,
  providerMessageId: z.string().min(1),
  phone: z.string().min(8),
  conversationExternalId: z.string().min(1),
  fromMe: z.boolean(),
  type: messageTypeSchema,
  text: z.string().nullable(),
  media: z
    .object({
      url: z.string().nullable(),
      mimeType: z.string().nullable(),
      correlationKey: z.string().nullable(),
    })
    .nullable(),
  replyToProviderMessageId: z.string().nullable(),
  isEdit: z.boolean(),
  timestamp: z.coerce.date(),
  metadata: z.record(z.string(), z.unknown()),
})

export const messageStatusUpdateSchema = z.object({
  kind: z.literal('message_status_update'),
  provider: providerSchema,
  providerMessageId: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.coerce.date(),
})

export const connectionStatusChangeSchema = z.object({
  kind: z.literal('connection_status_change'),
  provider: providerSchema,
  status: z.enum(['connected', 'disconnected', 'connecting']),
  reason: z.string().nullable(),
  timestamp: z.coerce.date(),
})

export const normalizedWebhookEventSchema = z.discriminatedUnion('kind', [
  incomingMessageSchema,
  messageStatusUpdateSchema,
  connectionStatusChangeSchema,
])

export type Provider = z.infer<typeof providerSchema>
export type MessageState = z.infer<typeof messageStateSchema>
export type IncomingMessage = z.infer<typeof incomingMessageSchema>
export type MessageStatusUpdate = z.infer<typeof messageStatusUpdateSchema>
export type ConnectionStatusChange = z.infer<typeof connectionStatusChangeSchema>
export type NormalizedWebhookEvent = z.infer<typeof normalizedWebhookEventSchema>
```

`packages/contracts/src/events.ts`:
```ts
import { z } from 'zod'

// Evento entre domínios (ADR-0004): publicado após o commit, consumers idempotentes.
export const domainEventSchema = z.object({
  name: z.string().min(1),
  companyId: z.string().uuid(),
  correlationId: z.string().uuid(),
  schemaVersion: z.number().int().positive(),
  occurredAt: z.coerce.date(),
  payload: z.record(z.string(), z.unknown()),
})

export type DomainEvent = z.infer<typeof domainEventSchema>
```

`packages/contracts/src/index.ts`:
```ts
export * from './webhooks.js'
export * from './events.js'
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @aios-pocket/contracts test` e `pnpm --filter @aios-pocket/contracts typecheck`
Expected: PASS nos dois.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat(contracts): tipos normalizados de webhook e evento de domínio (ADR-0003/0004)"
```

---

### Task 3: `packages/db` — schema Prisma do núcleo + migração

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma/schema.prisma`
- Create (gerada): `packages/db/prisma/migrations/*_core/migration.sql`

**Interfaces:**
- Consumes: Postgres local da Task 1 (`DATABASE_URL` já no `.env` da raiz).
- Produces: models Prisma `Company`, `User`, `Customer`, `Conversation`, `Message`, `CustomerEvent`, `RawWebhookEvent` (tabelas snake_case via `@@map`); scripts `db:generate`, `db:migrate`, `db:deploy`, `db:seed` (seed vem na Task 8).

- [ ] **Step 1: Criar o package**

`packages/db/package.json`:
```json
{
  "name": "@aios-pocket/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "dotenv -e ../../.env -- vitest run",
    "db:generate": "prisma generate",
    "db:migrate": "dotenv -e ../../.env -- prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:seed": "dotenv -e ../../.env -- tsx prisma/seed.ts"
  },
  "dependencies": {
    "@prisma/client": "^6.3.0",
    "@supabase/supabase-js": "^2.48.0"
  },
  "devDependencies": {
    "prisma": "^6.3.0",
    "dotenv-cli": "^8.0.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "prisma"] }
```

- [ ] **Step 2: Escrever o schema**

`packages/db/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Provider {
  evolution
  zapi
}

enum ConnectionState {
  connected
  disconnected
  connecting
}

enum ConversationStatus {
  open
  closed
}

enum MessageDirection {
  inbound
  outbound
}

enum MessageState {
  received
  queued
  sending
  sent
  delivered
  read
  failed
}

enum MessageType {
  text
  image
  audio
  video
  document
  sticker
  unknown
}

// Tenant. Exatamente um provider ativo por company; credenciais cifradas na aplicação (ADR-0002).
model Company {
  id                  String          @id @default(uuid()) @db.Uuid
  name                String
  activeProvider      Provider        @map("active_provider")
  providerCredentials String          @map("provider_credentials")
  connectionState     ConnectionState @default(disconnected) @map("connection_state")
  createdAt           DateTime        @default(now()) @map("created_at")

  users          User[]
  customers      Customer[]
  conversations  Conversation[]
  messages       Message[]
  customerEvents CustomerEvent[]

  @@map("companies")
}

model User {
  id         String   @id @default(uuid()) @db.Uuid
  companyId  String   @map("company_id") @db.Uuid
  authUserId String   @unique @map("auth_user_id") @db.Uuid
  name       String
  email      String
  createdAt  DateTime @default(now()) @map("created_at")

  company Company @relation(fields: [companyId], references: [id])

  @@map("users")
}

// Identidade canônica: E.164 + original preservado; matching com regra do 9º dígito (Domain.md).
model Customer {
  id            String   @id @default(uuid()) @db.Uuid
  companyId     String   @map("company_id") @db.Uuid
  phoneE164     String   @map("phone_e164")
  phoneOriginal String   @map("phone_original")
  name          String?
  createdAt     DateTime @default(now()) @map("created_at")

  company       Company         @relation(fields: [companyId], references: [id])
  conversations Conversation[]
  events        CustomerEvent[]

  @@unique([companyId, phoneE164])
  @@map("customers")
}

model Conversation {
  id            String             @id @default(uuid()) @db.Uuid
  companyId     String             @map("company_id") @db.Uuid
  customerId    String             @map("customer_id") @db.Uuid
  provider      Provider
  externalId    String             @map("external_id")
  status        ConversationStatus @default(open)
  lastMessageAt DateTime?          @map("last_message_at")
  createdAt     DateTime           @default(now()) @map("created_at")

  company  Company   @relation(fields: [companyId], references: [id])
  customer Customer  @relation(fields: [customerId], references: [id])
  messages Message[]

  @@unique([companyId, provider, externalId])
  @@map("conversations")
}

// Tabela única de mensagens com máquina de estados (ADR-0006). Dedupe pela unique abaixo.
model Message {
  id                       String           @id @default(uuid()) @db.Uuid
  companyId                String           @map("company_id") @db.Uuid
  conversationId           String           @map("conversation_id") @db.Uuid
  direction                MessageDirection
  state                    MessageState
  provider                 Provider
  providerMessageId        String?          @map("provider_message_id")
  fromMe                   Boolean          @default(false) @map("from_me")
  type                     MessageType
  text                     String?
  editedText               String?          @map("edited_text")
  mediaUrl                 String?          @map("media_url")
  mediaMimeType            String?          @map("media_mime_type")
  mediaCorrelationKey      String?          @map("media_correlation_key")
  replyToProviderMessageId String?          @map("reply_to_provider_message_id")
  failReason               String?          @map("fail_reason")
  correlationId            String           @map("correlation_id") @db.Uuid
  createdAt                DateTime         @default(now()) @map("created_at")

  company      Company      @relation(fields: [companyId], references: [id])
  conversation Conversation @relation(fields: [conversationId], references: [id])

  @@unique([companyId, provider, providerMessageId, direction])
  @@index([conversationId, createdAt])
  @@map("messages")
}

// Timeline append-only (ADR-0004): log, NÃO event sourcing — estado vive nas tabelas de domínio.
model CustomerEvent {
  id            String   @id @default(uuid()) @db.Uuid
  companyId     String   @map("company_id") @db.Uuid
  customerId    String   @map("customer_id") @db.Uuid
  type          String
  payload       Json
  schemaVersion Int      @map("schema_version")
  correlationId String   @map("correlation_id") @db.Uuid
  occurredAt    DateTime @map("occurred_at")
  createdAt     DateTime @default(now()) @map("created_at")

  company  Company  @relation(fields: [companyId], references: [id])
  customer Customer @relation(fields: [customerId], references: [id])

  @@index([companyId, customerId, occurredAt])
  @@map("customer_events")
}

// Arquivo de payload cru — fonte das fixtures. company_id nullable: arquiva mesmo sem tenant identificado.
model RawWebhookEvent {
  id         String   @id @default(uuid()) @db.Uuid
  provider   Provider
  companyId  String?  @map("company_id") @db.Uuid
  payload    Json
  processed  Boolean  @default(false)
  error      String?
  receivedAt DateTime @default(now()) @map("received_at")

  @@index([provider, processed])
  @@map("raw_webhook_events")
}
```

- [ ] **Step 3: Instalar, validar e migrar (docker da Task 1 precisa estar de pé)**

Run: `pnpm install`, depois `pnpm --filter @aios-pocket/db exec prisma validate`, depois `pnpm --filter @aios-pocket/db run db:migrate -- --name core`
Expected: validate OK; migração `*_core` criada e aplicada; `prisma generate` roda junto sem erro.

- [ ] **Step 4: Commit**

```bash
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): schema Prisma do núcleo de identidade + migração core (ADR-0006/0007)"
```

---

### Task 4: TenantContext + client extension + repository padrão

**Files:**
- Create: `packages/db/src/tenant-context.ts`, `packages/db/src/client.ts`, `packages/db/src/unsafe.ts`, `packages/db/src/repositories/customers.ts`, `packages/db/src/repositories/users.ts`, `packages/db/src/index.ts`
- Test: `packages/db/test/tenancy.test.ts`

**Interfaces:**
- Consumes: models da Task 3.
- Produces (consumidos por Task 6 e Planos B/C):
  - `runWithTenant<T>(ctx: { companyId: string }, fn: () => T): T` e `enterTenant(ctx: { companyId: string }): void`
  - `getTenant(): { companyId: string }` (lança `Error` se ausente)
  - `prisma` — client com tenancy enforçada (modelos isentos: só `RawWebhookEvent`; operações `findUnique/update/delete/upsert` proibidas — usar `findFirst`/`updateMany`/`deleteMany`)
  - `customersRepo.{findByPhone,create,list}`, `resolveUserByAuthId(authUserId)` (lookup global pré-tenant — a autenticação resolve o tenant)
  - `prismaUnsafe` (NÃO exportado no index; uso interno de seed/testes)

- [ ] **Step 1: Escrever o teste de tenancy que falha**

`packages/db/test/tenancy.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { prismaUnsafe } from '../src/unsafe.js'
import { prisma } from '../src/client.js'
import { runWithTenant } from '../src/tenant-context.js'
import { customersRepo } from '../src/repositories/customers.js'

let companyA = ''
let companyB = ''

beforeAll(async () => {
  await prismaUnsafe.message.deleteMany()
  await prismaUnsafe.customerEvent.deleteMany()
  await prismaUnsafe.conversation.deleteMany()
  await prismaUnsafe.customer.deleteMany()
  await prismaUnsafe.user.deleteMany()
  await prismaUnsafe.company.deleteMany()
  const a = await prismaUnsafe.company.create({
    data: { name: 'Empresa A', activeProvider: 'evolution', providerCredentials: 'cifrado' },
  })
  const b = await prismaUnsafe.company.create({
    data: { name: 'Empresa B', activeProvider: 'zapi', providerCredentials: 'cifrado' },
  })
  companyA = a.id
  companyB = b.id
  await prismaUnsafe.customer.create({
    data: { companyId: companyA, phoneE164: '+5511999990000', phoneOriginal: '5511999990000' },
  })
  await prismaUnsafe.customer.create({
    data: { companyId: companyB, phoneE164: '+5511999990000', phoneOriginal: '5511999990000' },
  })
})

describe('tenancy por aplicação (ADR-0001)', () => {
  it('leituras enxergam apenas o tenant do contexto', async () => {
    const rows = await runWithTenant({ companyId: companyA }, () => customersRepo.list())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.companyId).toBe(companyA)
  })

  it('criação injeta o company_id do contexto', async () => {
    const created = await runWithTenant({ companyId: companyA }, () =>
      customersRepo.create({ phoneE164: '+5511888880000', phoneOriginal: '5511888880000' }),
    )
    expect(created.companyId).toBe(companyA)
  })

  it('lança erro sem TenantContext', async () => {
    await expect(customersRepo.list()).rejects.toThrow('TenantContext')
  })

  it('proíbe operações que não aceitam filtro de tenant', async () => {
    await expect(
      runWithTenant({ companyId: companyA }, () =>
        prisma.customer.findUnique({ where: { id: companyA } }),
      ),
    ).rejects.toThrow('proibida')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @aios-pocket/db test`
Expected: FAIL — módulos `../src/*` inexistentes.

- [ ] **Step 3: Implementar**

`packages/db/src/tenant-context.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks'

export interface TenantContext {
  companyId: string
}

const storage = new AsyncLocalStorage<TenantContext>()

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

// Para hooks do Fastify: fixa o contexto na execução assíncrona da request corrente.
export function enterTenant(ctx: TenantContext): void {
  storage.enterWith(ctx)
}

export function getTenant(): TenantContext {
  const ctx = storage.getStore()
  if (!ctx) throw new Error('TenantContext ausente — toda operação de dados exige tenant (ADR-0001)')
  return ctx
}
```

`packages/db/src/unsafe.ts`:
```ts
// USO RESTRITO: seed, testes e resolução de auth (pré-tenant). Nunca em código de domínio.
import { PrismaClient } from '@prisma/client'

export const prismaUnsafe = new PrismaClient()
```

`packages/db/src/client.ts`:
```ts
import { PrismaClient } from '@prisma/client'
import { getTenant } from './tenant-context.js'

// Whitelist de modelos sem tenant — manter mínima e justificada.
const TENANT_EXEMPT_MODELS = new Set(['RawWebhookEvent'])
// Operações cujo `where` unique não aceita composição com company_id de forma segura.
const FORBIDDEN_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert'])

export function createTenantClient(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (TENANT_EXEMPT_MODELS.has(model)) return query(args)
          if (FORBIDDEN_OPERATIONS.has(operation)) {
            throw new Error(
              `Operação ${operation} proibida em ${model}: use findFirst/updateMany/deleteMany com filtro de tenant`,
            )
          }
          const { companyId } = getTenant()
          const a = args as { where?: object; data?: object | object[] }
          let next: object
          if (operation === 'create') {
            next = { ...a, data: { ...(a.data as object), companyId } }
          } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const rows = Array.isArray(a.data) ? a.data : [a.data as object]
            next = { ...a, data: rows.map((d) => ({ ...d, companyId })) }
          } else {
            next = { ...a, where: { AND: [{ companyId }, a.where ?? {}] } }
          }
          return query(next as Parameters<typeof query>[0])
        },
      },
    },
  })
}

export const prisma = createTenantClient(new PrismaClient())
```

`packages/db/src/repositories/customers.ts`:
```ts
import { prisma } from '../client.js'
import { getTenant } from '../tenant-context.js'

// Repository padrão: types do Prisma exigem companyId explícito no create;
// a extension revalida/injeta em runtime como cinto de segurança.
export const customersRepo = {
  findByPhone(phoneE164: string) {
    return prisma.customer.findFirst({ where: { phoneE164 } })
  },
  create(data: { phoneE164: string; phoneOriginal: string; name?: string }) {
    return prisma.customer.create({ data: { ...data, companyId: getTenant().companyId } })
  },
  list() {
    return prisma.customer.findMany({ orderBy: { createdAt: 'desc' } })
  },
}
```

`packages/db/src/repositories/users.ts`:
```ts
import { prismaUnsafe } from '../unsafe.js'

// Pré-tenant: a autenticação resolve o tenant a partir do usuário.
// Este é o ÚNICO lookup global permitido fora de seed/testes.
export function resolveUserByAuthId(authUserId: string) {
  return prismaUnsafe.user.findUnique({ where: { authUserId }, include: { company: true } })
}
```

`packages/db/src/index.ts`:
```ts
export { prisma, createTenantClient } from './client.js'
export { runWithTenant, enterTenant, getTenant, type TenantContext } from './tenant-context.js'
export { customersRepo } from './repositories/customers.js'
export { resolveUserByAuthId } from './repositories/users.js'
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @aios-pocket/db run db:generate` e `pnpm --filter @aios-pocket/db test`
Expected: PASS nos 4 testes. Também `pnpm --filter @aios-pocket/db typecheck` PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): TenantContext com client extension e repositories (ADR-0001)"
```

---

### Task 5: Enforcement mecânico — ESLint + teste de arquitetura

**Files:**
- Create: `eslint.config.js`, `tests/architecture/prisma-schema.test.ts`
- Modify: `package.json` (raiz — devDependencies)

**Interfaces:**
- Consumes: `packages/db/prisma/schema.prisma` (Task 3).
- Produces: `pnpm lint` e `pnpm test:arch` verdes usados pelo CI (Task 8); regras que os Planos B/C/D herdam automaticamente.

- [ ] **Step 1: Adicionar devDependencies na raiz**

Em `package.json` (raiz), acrescentar em `devDependencies` (manter as existentes):
```json
{
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.7.2",
    "eslint": "^9.20.0",
    "@eslint/js": "^9.20.0",
    "typescript-eslint": "^8.24.0",
    "vitest": "^3.0.0"
  }
}
```
Run: `pnpm install`

- [ ] **Step 2: Escrever o teste de arquitetura (falha se nascer tabela sem company_id)**

`tests/architecture/prisma-schema.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Tabelas globais sem company_id exigem entrada aqui + justificativa em ADR.
// Company É o próprio tenant — única exceção de nascença.
const WHITELIST = new Set<string>(['Company'])

const schema = readFileSync(
  new URL('../../packages/db/prisma/schema.prisma', import.meta.url),
  'utf8',
)
const models = [...schema.matchAll(/model\s+(\w+)\s+\{([\s\S]*?)\n\}/g)].map((m) => ({
  name: m[1] ?? '',
  body: m[2] ?? '',
}))

describe('arquitetura: tenancy no schema (ADR-0001)', () => {
  it('encontrou models no schema', () => {
    expect(models.length).toBeGreaterThanOrEqual(7)
  })

  it.each(models)('model $name tem coluna company_id ou está na whitelist', ({ name, body }) => {
    if (WHITELIST.has(name)) return
    expect(body, `model ${name} nasceu sem company_id`).toContain('@map("company_id")')
  })
})
```

Run: `pnpm test:arch`
Expected: PASS — 6 models têm `@map("company_id")`; `Company` passa pela whitelist (é o próprio tenant).

- [ ] **Step 3: Escrever a config ESLint**

`eslint.config.js`:
```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.js', '!eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Prisma só em packages/db (ADR-0001)
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@prisma/client', message: 'Prisma só em packages/db (ADR-0001). Use os repositories de @aios-pocket/db.' }] },
      ],
    },
  },
  {
    // Hosts de provider só em packages/providers (ADR-0002)
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/providers/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/aios-evolution|z-api\\u002eio/]',
          message: 'Chamada direta a provider fora de packages/providers viola a arquitetura (ADR-0002).',
        },
      ],
    },
  },
)
```

Run: `pnpm lint`
Expected: PASS no código existente.

- [ ] **Step 4: Provar que as regras mordem**

Criar `packages/contracts/src/tmp-violation.ts` com:
```ts
import { PrismaClient } from '@prisma/client'
export const x: any = new PrismaClient()
```
Run: `pnpm lint`
Expected: FAIL com os erros `no-restricted-imports` e `no-explicit-any`.
Depois: apagar `packages/contracts/src/tmp-violation.ts` e rodar `pnpm lint` de novo → PASS.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js tests/architecture package.json pnpm-lock.yaml
git commit -m "feat: enforcement mecânico — lint de arquitetura e teste de tenancy no schema"
```

---

### Task 6: `apps/api` — esqueleto Fastify com auth Supabase e TenantContext por request

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/config.ts`, `apps/api/src/auth/verify.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`
- Test: `apps/api/test/app.test.ts`

**Interfaces:**
- Consumes: `resolveUserByAuthId`, `enterTenant` de `@aios-pocket/db` (Task 4).
- Produces: `buildApp(): FastifyInstance` (rotas novas dos Planos B/C penduram aqui); `config` tipado; convenção de rotas públicas: prefixos `/health` e `/webhooks/`.

- [ ] **Step 1: Criar package e teste que falha**

`apps/api/package.json`:
```json
{
  "name": "@aios-pocket/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "dotenv -e ../../.env -- tsx watch src/server.ts",
    "typecheck": "tsc --noEmit",
    "test": "dotenv -e ../../.env -- vitest run"
  },
  "dependencies": {
    "@aios-pocket/contracts": "workspace:*",
    "@aios-pocket/db": "workspace:*",
    "fastify": "^5.2.0",
    "jose": "^6.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "dotenv-cli": "^8.0.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/api/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`apps/api/test/app.test.ts`:
```ts
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

const app = buildApp()
afterAll(() => app.close())

describe('esqueleto da API', () => {
  it('GET /health responde 200 sem auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('rota protegida sem token responde 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(401)
  })

  it('token inválido responde 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer token-invalido' },
    })
    expect(res.statusCode).toBe(401)
  })
})
```

Run: `pnpm install` e `pnpm --filter @aios-pocket/api test`
Expected: FAIL — `../src/app.js` inexistente.

- [ ] **Step 2: Implementar**

`apps/api/src/config.ts`:
```ts
import { z } from 'zod'

// Env carregado pelos scripts via dotenv-cli (scripts standalone não leem .env sozinhos).
const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  SUPABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
})

export const config = envSchema.parse(process.env)
```

`apps/api/src/auth/verify.ts`:
```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'

const jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', config.SUPABASE_URL))

export async function verifySupabaseJwt(token: string): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(token, jwks)
  if (!payload.sub) throw new Error('token sem sub')
  return { sub: payload.sub }
}
```

`apps/api/src/app.ts`:
```ts
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { enterTenant, getTenant, resolveUserByAuthId } from '@aios-pocket/db'
import { verifySupabaseJwt } from './auth/verify.js'

// Rotas sem auth: health e webhooks (webhooks autenticam por token de instância — Plano B).
const PUBLIC_PREFIXES = ['/health', '/webhooks/']

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true, genReqId: () => randomUUID() })

  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'não autenticado' })
    }
    try {
      const { sub } = await verifySupabaseJwt(header.slice('Bearer '.length))
      const user = await resolveUserByAuthId(sub)
      if (!user) return reply.code(401).send({ error: 'usuário não cadastrado' })
      enterTenant({ companyId: user.companyId })
    } catch {
      return reply.code(401).send({ error: 'token inválido' })
    }
  })

  app.get('/health', async () => ({ status: 'ok' }))

  // Rota protegida mínima: prova o fluxo auth → tenant (e serve à UI no Plano C).
  app.get('/me', async () => {
    const { companyId } = getTenant()
    return { companyId }
  })

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'rota inexistente' }))

  return app
}
```

`apps/api/src/server.ts`:
```ts
import { buildApp } from './app.js'
import { config } from './config.js'

const app = buildApp()

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
```

Nota sobre os testes de 401: com token `Bearer token-invalido`, o `jwtVerify` falha antes de tocar banco ou rede — o teste não precisa de Postgres nem de JWKS acessível. Hooks globais não valem para o not-found handler do Fastify, por isso os testes usam a rota protegida real `/me`, não uma URL inexistente.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm --filter @aios-pocket/api test` e `pnpm --filter @aios-pocket/api typecheck`
Expected: PASS (3 testes).

- [ ] **Step 4: Fumaça manual**

Run: `pnpm --filter @aios-pocket/api dev` (deixar 5s e encerrar com Ctrl+C)
Expected: log `Server listening at http://0.0.0.0:3001`; `curl http://localhost:3001/health` responde `{"status":"ok"}`.

- [ ] **Step 5: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): esqueleto Fastify com auth Supabase JWT e TenantContext por request"
```

---

### Task 7: Fila BullMQ + eventos de domínio idempotentes

**Files:**
- Create: `apps/api/src/queue/connection.ts`, `apps/api/src/queue/queues.ts`, `apps/api/src/queue/events.ts`, `apps/api/src/queue/workers.ts`
- Test: `apps/api/test/events.test.ts`

**Interfaces:**
- Consumes: `domainEventSchema`, `DomainEvent` de `@aios-pocket/contracts` (Task 2); Redis local (Task 1); `config` (Task 6).
- Produces (consumidos pelos Planos B/C):
  - `QUEUE = { webhookProcessing: 'webhook-processing', messageSend: 'message-send', domainEvents: 'domain-events' }`
  - `webhookProcessingQueue`, `messageSendQueue`, `domainEventsQueue` (instâncias `Queue` do BullMQ)
  - `publishDomainEvent(event: DomainEvent): Promise<void>` — chamar SEMPRE após o commit
  - `onDomainEvent(name: string, handler: (e: DomainEvent) => Promise<void>): void`
  - `startDomainEventsWorker(): Worker`

- [ ] **Step 1: Adicionar dependências**

Em `apps/api/package.json`, acrescentar em `dependencies`: `"bullmq": "^5.34.0"` e `"ioredis": "^5.4.0"`.
Run: `pnpm install`

- [ ] **Step 2: Escrever o teste que falha**

`apps/api/test/events.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { Worker } from 'bullmq'

// Teste de integração: exige Redis local (docker compose up -d).
import { onDomainEvent, publishDomainEvent } from '../src/queue/events.js'
import { startDomainEventsWorker } from '../src/queue/workers.js'
import { domainEventsQueue } from '../src/queue/queues.js'
import { redisConnection } from '../src/queue/connection.js'

let worker: Worker | undefined
afterAll(async () => {
  await worker?.close()
  await domainEventsQueue.close()
  await redisConnection.quit()
})

describe('eventos de domínio (ADR-0004)', () => {
  it('publicação em duplicata processa uma única vez (jobId por correlationId)', async () => {
    const processados: string[] = []
    onDomainEvent('TesteEvento', async (e) => {
      processados.push(e.correlationId)
    })
    worker = startDomainEventsWorker()

    const event = {
      name: 'TesteEvento',
      companyId: randomUUID(),
      correlationId: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date(),
      payload: { valor: 42 },
    }
    await publishDomainEvent(event)
    await publishDomainEvent(event)

    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(processados).toEqual([event.correlationId])
  }, 15000)
})
```

Run: `pnpm --filter @aios-pocket/api test`
Expected: FAIL — módulos `../src/queue/*` inexistentes (o teste de app da Task 6 segue passando).

- [ ] **Step 3: Implementar**

`apps/api/src/queue/connection.ts`:
```ts
import IORedis from 'ioredis'
import { config } from '../config.js'

// maxRetriesPerRequest: null é exigência do BullMQ para conexões de worker.
export const redisConnection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null })
```

`apps/api/src/queue/queues.ts`:
```ts
import { Queue } from 'bullmq'
import { redisConnection } from './connection.js'

export const QUEUE = {
  webhookProcessing: 'webhook-processing',
  messageSend: 'message-send',
  domainEvents: 'domain-events',
} as const

export const webhookProcessingQueue = new Queue(QUEUE.webhookProcessing, { connection: redisConnection })
export const messageSendQueue = new Queue(QUEUE.messageSend, { connection: redisConnection })
export const domainEventsQueue = new Queue(QUEUE.domainEvents, { connection: redisConnection })
```

`apps/api/src/queue/events.ts`:
```ts
import { type DomainEvent, domainEventSchema } from '@aios-pocket/contracts'
import { domainEventsQueue } from './queues.js'

type Handler = (event: DomainEvent) => Promise<void>

const handlers = new Map<string, Handler[]>()

export function onDomainEvent(name: string, handler: Handler): void {
  handlers.set(name, [...(handlers.get(name) ?? []), handler])
}

export function getHandlers(name: string): Handler[] {
  return handlers.get(name) ?? []
}

// Publicar SEMPRE depois do commit da transação (ADR-0004).
// jobId dedupa a PUBLICAÇÃO enquanto o job vive na fila; a garantia
// permanente de idempotência é responsabilidade dos consumers.
export async function publishDomainEvent(event: DomainEvent): Promise<void> {
  domainEventSchema.parse(event)
  await domainEventsQueue.add(event.name, event, {
    jobId: `${event.name}:${event.correlationId}`,
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: false,
  })
}
```

`apps/api/src/queue/workers.ts`:
```ts
import { Worker } from 'bullmq'
import { domainEventSchema } from '@aios-pocket/contracts'
import { redisConnection } from './connection.js'
import { QUEUE } from './queues.js'
import { getHandlers } from './events.js'

export function startDomainEventsWorker(): Worker {
  return new Worker(
    QUEUE.domainEvents,
    async (job) => {
      const event = domainEventSchema.parse(job.data)
      for (const handler of getHandlers(event.name)) {
        await handler(event)
      }
    },
    { connection: redisConnection },
  )
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @aios-pocket/api test` e `pnpm --filter @aios-pocket/api typecheck`
Expected: PASS (4 testes no total).

- [ ] **Step 5: Ligar os workers ao processo único**

Em `apps/api/src/server.ts`, substituir o conteúdo por:
```ts
import { buildApp } from './app.js'
import { config } from './config.js'
import { startDomainEventsWorker } from './queue/workers.js'

const app = buildApp()

// Um único deployable: API + workers no mesmo processo (stack inegociável).
startDomainEventsWorker()

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
```

Run: `pnpm --filter @aios-pocket/api test` (garante que nada quebrou)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): fila BullMQ e eventos de domínio idempotentes no processo único (ADR-0004)"
```

---

### Task 8: Cifra de credenciais + seed do piloto + CI verde

**Files:**
- Create: `packages/db/src/crypto.ts`, `packages/db/prisma/seed.ts`, `.github/workflows/ci.yml`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/crypto.test.ts`

**Interfaces:**
- Consumes: `prismaUnsafe` (Task 4), env do `.env` da raiz (Supabase, Evolution, Z-API, `APP_ENCRYPTION_KEY`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`).
- Produces: `encryptJson(value, keyB64)` / `decryptJson<T>(payload, keyB64)` exportados de `@aios-pocket/db` (Plano B usa para ler credenciais de provider); banco seedado com 1 company (`Aios Pocket`, provider ativo `evolution`, credenciais dos DOIS providers cifradas) + 1 user vinculado ao Supabase Auth; CI completo.

- [ ] **Step 1: Teste da cifra que falha**

`packages/db/test/crypto.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { encryptJson, decryptJson } from '../src/crypto.js'

const KEY = 'CTsyIGgQZbdhAtVZDdWLmeYUFrsGxJCVyBqNbGVw5CE=' // 32 bytes base64, só para teste

describe('cifra de credenciais (AES-256-GCM)', () => {
  it('roundtrip preserva o objeto', () => {
    const original = { evolution: { apiKey: 'segredo-123' } }
    const cifrado = encryptJson(original, KEY)
    expect(cifrado).not.toContain('segredo-123')
    expect(decryptJson(cifrado, KEY)).toEqual(original)
  })

  it('payload adulterado falha', () => {
    const cifrado = encryptJson({ a: 1 }, KEY)
    const adulterado = cifrado.slice(0, -4) + 'AAAA'
    expect(() => decryptJson(adulterado, KEY)).toThrow()
  })
})
```

Run: `pnpm --filter @aios-pocket/db test`
Expected: FAIL — `../src/crypto.js` inexistente (testes de tenancy seguem passando).

- [ ] **Step 2: Implementar a cifra**

`packages/db/src/crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM: payload = base64(iv[12] + authTag[16] + ciphertext)
export function encryptJson(value: unknown, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decryptJson<T>(payload: string, keyB64: string): T {
  const key = Buffer.from(keyB64, 'base64')
  const raw = Buffer.from(payload, 'base64')
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plain.toString('utf8')) as T
}
```

Em `packages/db/src/index.ts`, acrescentar:
```ts
export { encryptJson, decryptJson } from './crypto.js'
```

Run: `pnpm --filter @aios-pocket/db test`
Expected: PASS.

- [ ] **Step 3: Escrever o seed**

`packages/db/prisma/seed.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { prismaUnsafe } from '../src/unsafe.js'
import { encryptJson } from '../src/crypto.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`env ${name} ausente — confira o .env da raiz`)
  return value
}

// Cria (ou reaproveita) o usuário no Supabase Auth. Sem Supabase no env, usa id sintético (dev local).
async function ensureAuthUser(email: string, password: string): Promise<string> {
  const url = process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRole) {
    console.warn('Supabase ausente no env — usando auth_user_id sintético (apenas dev local)')
    return randomUUID()
  }
  const supabase = createClient(url, serviceRole)
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) {
    const { data: list, error: listError } = await supabase.auth.admin.listUsers()
    if (listError) throw listError
    const existing = list.users.find((u) => u.email === email)
    if (existing) return existing.id
    throw error
  }
  return data.user.id
}

async function main(): Promise<void> {
  const email = requireEnv('SEED_USER_EMAIL')
  const authUserId = await ensureAuthUser(email, requireEnv('SEED_USER_PASSWORD'))

  const credentials = encryptJson(
    {
      evolution: {
        baseUrl: requireEnv('EVOLUTION_BASE_URL'),
        apiKey: requireEnv('EVOLUTION_API_KEY'),
        instanceId: requireEnv('EVOLUTION_INSTANCE_ID'),
      },
      zapi: {
        baseUrl: requireEnv('ZAPI_BASE_URL'),
        instanceId: requireEnv('ZAPI_INSTANCE_ID'),
        instanceToken: requireEnv('ZAPI_INSTANCE_TOKEN'),
        clientToken: requireEnv('ZAPI_CLIENT_TOKEN'),
      },
    },
    requireEnv('APP_ENCRYPTION_KEY'),
  )

  const existing = await prismaUnsafe.company.findFirst({ where: { name: 'Aios Pocket' } })
  const company = existing
    ? await prismaUnsafe.company.update({
        where: { id: existing.id },
        data: { providerCredentials: credentials },
      })
    : await prismaUnsafe.company.create({
        data: { name: 'Aios Pocket', activeProvider: 'evolution', providerCredentials: credentials },
      })

  await prismaUnsafe.user.upsert({
    where: { authUserId },
    update: { email },
    create: { companyId: company.id, authUserId, name: 'Piloto', email },
  })

  console.log(`seed ok — company ${company.id}, user auth ${authUserId}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prismaUnsafe.$disconnect())
```

- [ ] **Step 4: Rodar o seed e verificar**

Run: `pnpm --filter @aios-pocket/db run db:seed`
Expected: `seed ok — company <uuid>, user auth <uuid>`. Rodar de novo → mesmo resultado, sem duplicar (idempotente).

- [ ] **Step 5: Escrever o CI**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [master, main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: aios_pocket
        ports:
          - 55432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:55432/aios_pocket
      REDIS_URL: redis://localhost:6379
      SUPABASE_URL: https://example.supabase.co
      APP_ENCRYPTION_KEY: CTsyIGgQZbdhAtVZDdWLmeYUFrsGxJCVyBqNbGVw5CE=
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # scripts de package usam `dotenv -e ../../.env` — no CI o arquivo não existe; cria vazio
      - run: touch .env
      - run: pnpm --filter @aios-pocket/db run db:generate
      - run: pnpm --filter @aios-pocket/db run db:deploy
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm test:arch
```

- [ ] **Step 6: Validar tudo localmente como o CI faria**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:arch`
Expected: tudo PASS.

- [ ] **Step 7: Commit e push (cria o remoto se ainda não existir)**

```bash
git add packages/db .github
git commit -m "feat: cifra de credenciais, seed do piloto e pipeline de CI"
```
Se houver remoto GitHub configurado, `git push` e conferir o CI verde no Actions. Se não houver, criar com `gh repo create aios-pocket --private --source . --push` (confirmar com o usuário o owner/organização antes).

---

## Critério de pronto do Plano A

1. `pnpm typecheck && pnpm lint && pnpm test && pnpm test:arch` verdes localmente e no CI.
2. Banco local com as 7 tabelas do núcleo migradas; seed idempotente com company piloto (credenciais dos dois providers cifradas) e usuário real no Supabase Auth.
3. Tenancy provada por teste: leitura cruzada entre tenants impossível; operação sem contexto lança erro.
4. Lint que morde: `any`, Prisma fora de `packages/db` e host de provider fora de `packages/providers` quebram o build.
5. API de pé com `/health` público e 401 para o resto; worker de eventos rodando no mesmo processo; evento duplicado processado uma vez.

**Pendências que NÃO bloqueiam este plano** (registradas para os próximos): senha do banco Supabase (`SUPABASE_DATABASE_URL`) para migrar o banco remoto — necessária no Plano C; acessos EasyPanel (deploy da API + Redis) — necessários no Plano B para webhook público estável (alternativa: túnel cloudflared); Vercel CLI/projeto — Plano C.



