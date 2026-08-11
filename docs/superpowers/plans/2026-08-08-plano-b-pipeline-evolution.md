# Aios Pocket — Plano B: Pipeline Evolution (Fatia 0/1, parte 2 de 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mensagem real de WhatsApp entra pelo webhook, vira Customer/Conversation/Message/Timeline no banco, e uma resposta enviada pela API chega no celular — via uma instância Evolution **dedicada ao projeto**, com fixtures reais capturadas ao vivo e a API deployada no EasyPanel.

**Architecture:** `packages/providers` ganha o contrato `MessagingProvider` + `EvolutionProvider` (único lugar que conhece a Evolution). `apps/api` ganha webhooks com arquivamento de payload cru, worker de processamento inbound e worker de envio. Fixtures reais sanitizadas viram a suíte de contrato que o ZApiProvider terá que passar no Plano D. Spec: `docs/superpowers/specs/2026-08-08-fatia-0-design.md` §5-6; carry-over obrigatório: `docs/superpowers/2026-08-08-plano-a-carryover.md`.

**Tech Stack:** o mesmo do Plano A + undici/fetch nativo (chamadas Evolution), cloudflared (túnel de captura), Docker + GHCR (deploy).

**Fatos de ambiente (sondados ao vivo, 2026-08-08):**
> Credenciais que apareceram em versões deste documento foram ROTACIONADAS em 2026-08-10 — valores históricos são inválidos.
- Evolution da produção: `https://aios-evolution.yspmhc.easypanel.host`, v2, instância `murilo` conectada — **webhook dela alimenta o n8n da operação: INTOCÁVEL**.
- Decisão do usuário: **Evolution dev dedicada** como serviço novo no projeto `aios-pocket` do EasyPanel (droplet 143.198.98.6), usando o `postgres-dev` (database separado `evolution`) e o `redis-dev` (DB index 3) já existentes.
- API key da Evolution dev (gerada; vai para o .env na Task 4): `<EVOLUTION_API_KEY>`.
- Domínio previsto da Evolution dev: `aios-pocket-evolution-dev.yspmhc.easypanel.host` (porta interna 8080).

## Global Constraints

- Tudo do Plano A permanece: TS strict, `any` proibido, Prisma só em `packages/db`, hosts de provider só em `packages/providers` (lint cobre string e template literal), toda tabela com `company_id`, comentários/commits em português, identificadores em inglês, segredos só no `.env`.
- **PRODUÇÃO INTOCÁVEL:** nunca tocar no projeto `aios` do EasyPanel, na instância `murilo`, no webhook do n8n, nem buildar imagem no droplet. Toda operação nova ganha limite de memória no EasyPanel.
- Rota HTTP nunca espera provider (fila BullMQ); webhook responde 200 antes de processar; payload cru NUNCA se perde.
- Todo webhook idempotente (dedupe por provider + providerMessageId + tipo de evento); consumers idempotentes; `correlation_id` em tudo.
- Fixture inventada é PROIBIDA quando existir payload real: a ordem das tasks garante captura real antes do parser.
- Alteração estrutural (coluna nova, contrato novo) referencia a ADR correspondente no commit.
- Env novo entra em `.env`, `.env.example` E na lista `tasks.test.env` do turbo.json se algum teste o consome (lição do CI real).
- Antes de cada commit: testes do package tocado; gate completo (`pnpm typecheck && pnpm lint && pnpm test && pnpm test:arch`) na última task de cada frente.
- Trabalhar em branch nova `plano-b-pipeline-evolution` a partir de `master`.

---

### Task 1: Hardening de runtime (carry-over do Plano A)

**Files:**
- Modify: `apps/api/src/queue/connection.ts`, `packages/db/src/client.ts`, `packages/db/src/unsafe.ts`, `packages/db/src/crypto.ts`, `packages/db/src/index.ts`, `packages/db/src/tenant-context.ts`, `packages/contracts/src/events.ts`, `apps/api/src/app.ts`
- Test: `packages/db/test/crypto.test.ts` (novo caso), suítes existentes seguem verdes

**Interfaces:**
- Consumes: código do Plano A.
- Produces: mesmos exports públicos, MENOS `enterTenant` (removido — código morto perigoso; `runWithTenant` é o único caminho); `prisma` passa a compartilhar o pool com `prismaUnsafe`.

- [ ] **Step 1: Listeners de erro nas conexões Redis**

Em `apps/api/src/queue/connection.ts`, após criar cada conexão:
```ts
// Sem listener de 'error', um blip do Redis derruba o processo inteiro (evento não tratado).
redisWorkerConnection.on('error', (err) => {
  console.error('[redis worker] erro de conexão', err.message)
})
redisQueueConnection.on('error', (err) => {
  console.error('[redis queue] erro de conexão', err.message)
})
```

- [ ] **Step 2: Pool Prisma único**

Em `packages/db/src/client.ts`, trocar a última linha:
```ts
// Um único pool de conexões: o client tenantizado é uma extensão do mesmo PrismaClient
// base usado por prismaUnsafe (seed/testes/pré-tenant) — droplet compartilhado agradece.
import { prismaUnsafe } from './unsafe.js'
export const prisma = createTenantClient(prismaUnsafe)
```
(Remover o `new PrismaClient()` local e o import não usado, mantendo `createTenantClient` exportado.)

- [ ] **Step 3: Validação de chave na cifra + teste**

Em `packages/db/src/crypto.ts`, no início de `encryptJson` e `decryptJson`:
```ts
const key = Buffer.from(keyB64, 'base64')
if (key.length !== 32) {
  throw new Error('APP_ENCRYPTION_KEY inválida: esperados 32 bytes em base64')
}
```
Novo teste em `packages/db/test/crypto.test.ts`:
```ts
it('chave de tamanho errado falha com erro claro', () => {
  expect(() => encryptJson({ a: 1 }, 'Y3VydGE=')).toThrow('32 bytes')
  expect(() => decryptJson('AAAA', 'Y3VydGE=')).toThrow('32 bytes')
})
```

- [ ] **Step 4: Timeout no JWKS**

Em `apps/api/src/auth/verify.ts`:
```ts
const jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', config.SUPABASE_URL), {
  timeoutDuration: 5000, // Supabase indisponível = falha em 5s, não espera default
})
```

- [ ] **Step 5: Zod sem API deprecated**

Em `packages/contracts/src/events.ts`: `z.string().uuid()` → `z.uuid()` (2 ocorrências). Rodar os testes de contracts.

- [ ] **Step 6: Remover `enterTenant` do export público**

- Em `packages/db/src/index.ts`: remover `enterTenant` da linha de export.
- Em `packages/db/src/tenant-context.ts`: apagar a função `enterTenant` inteira (com o warning comment) — é o footgun exato que causou o Critical da revisão final e não tem mais callers.
- Confirmar por grep que nada importa `enterTenant`.

- [ ] **Step 7: Verificar e commitar**

Run: `pnpm --filter @aios-pocket/db run db:generate && pnpm typecheck && pnpm lint && pnpm test && pnpm test:arch`
Expected: tudo verde (os testes de db/api rodam contra a infra remota).
```bash
git add -A
git commit -m "chore: hardening do carry-over — pool único, listeners redis, chave validada, jwks timeout, zod atual, enterTenant removido"
```

---

### Task 2: Hardening de CI (carry-over do Plano A)

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI que detecta drift de migração e usa actions atuais.

- [ ] **Step 1: Bump das actions e step de drift**

Em `.github/workflows/ci.yml`: `actions/checkout@v4` → `@v5`; `actions/setup-node@v4` → `@v5`; `pnpm/action-setup@v4` → mantém (checar major mais novo; se v5 existir, usar). Após o step de `db:deploy`, inserir:
```yaml
      # Detecta schema.prisma editado sem migração gerada (drift silencioso)
      - run: >
          pnpm --filter @aios-pocket/db exec prisma migrate diff
          --from-migrations prisma/migrations
          --to-schema-datamodel prisma/schema.prisma
          --shadow-database-url "$DATABASE_URL"
          --exit-code
```
Nota: `--shadow-database-url` usa o service Postgres do CI. Se a flag falhar na versão instalada do Prisma, usar `--from-migrations` com `--shadow-database-url` conforme `prisma migrate diff --help` e registrar o ajuste.

- [ ] **Step 2: Commit e prova no CI real**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: detecta drift de migracao e atualiza actions"
git push -u origin plano-b-pipeline-evolution
```
Abrir PR de rascunho (`gh pr create --draft --title "Plano B: pipeline Evolution" --body "em execução"`) só para o CI rodar na branch; conferir verde com `gh run watch`. O PR fica aberto até o fim do plano.

---

### Task 3: Telefone canônico — E.164 + regra do 9º dígito (TDD puro)

**Files:**
- Create: `packages/db/src/phone.ts`
- Test: `packages/db/test/phone.test.ts`
- Modify: `packages/db/src/index.ts` (export)

**Interfaces:**
- Produces (consumidos pela Task 9): `canonicalizePhone(raw: string): { e164: string; original: string }` e `phoneMatchCandidates(e164: string): string[]` — para BR móvel, retorna as DUAS formas (com e sem o 9) para matching de Customer; para não-BR ou fixo, retorna só a própria.

- [ ] **Step 1: Teste que falha**

`packages/db/test/phone.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { canonicalizePhone, phoneMatchCandidates } from '../src/phone.js'

describe('telefone canônico (Domain.md: E.164 + 9º dígito)', () => {
  it('normaliza formatos comuns de webhook para E.164', () => {
    expect(canonicalizePhone('5515991230001').e164).toBe('+5515991230001')
    expect(canonicalizePhone('5515991230001@s.whatsapp.net').e164).toBe('+5515991230001')
    expect(canonicalizePhone('+55 (15) 99123-0001').e164).toBe('+5515991230001')
    expect(canonicalizePhone('551533044782').e164).toBe('+551533044782') // fixo, 8 dígitos
  })

  it('preserva o original como veio', () => {
    const r = canonicalizePhone('5515991230001@s.whatsapp.net')
    expect(r.original).toBe('5515991230001@s.whatsapp.net')
  })

  it('candidatos de matching cobrem o 9º dígito nos dois sentidos', () => {
    // móvel BR COM 9: candidato alternativo é SEM o 9
    expect(phoneMatchCandidates('+5515991230001')).toEqual(['+5515991230001', '+551591230001'])
    // móvel BR SEM 9 (8 dígitos começando em 9123): alternativo é COM o 9
    expect(phoneMatchCandidates('+551591230001')).toEqual(['+551591230001', '+5515991230001'])
    // fixo BR: sem alternativo
    expect(phoneMatchCandidates('+551533044782')).toEqual(['+551533044782'])
    // não-BR: sem alternativo
    expect(phoneMatchCandidates('+14155552671')).toEqual(['+14155552671'])
  })

  it('rejeita entrada sem dígitos suficientes', () => {
    expect(() => canonicalizePhone('abc')).toThrow('telefone')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar** — `pnpm --filter @aios-pocket/db test` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

`packages/db/src/phone.ts`:
```ts
// Identidade canônica de telefone (Domain.md): E.164 + original preservado.
// Regra do 9º dígito BR: móveis têm 9 dígitos (9XXXXXXXX); o mesmo cliente pode
// chegar com ou sem o 9 dependendo do provider/época — matching considera os dois.

export interface CanonicalPhone {
  e164: string
  original: string
}

export function canonicalizePhone(raw: string): CanonicalPhone {
  const digits = raw.replace(/@.*$/, '').replace(/\D/g, '')
  if (digits.length < 8) {
    throw new Error(`telefone inválido: "${raw}"`)
  }
  return { e164: `+${digits}`, original: raw }
}

export function phoneMatchCandidates(e164: string): string[] {
  const br = /^\+55(\d{2})(\d{8,9})$/.exec(e164)
  if (!br) return [e164]
  const [, ddd, local] = br
  if (local !== undefined && local.length === 9 && local.startsWith('9')) {
    return [e164, `+55${ddd}${local.slice(1)}`] // com 9 → alternativo sem 9
  }
  if (local !== undefined && local.length === 8 && /^[6-9]/.test(local)) {
    return [e164, `+55${ddd}9${local}`] // móvel antigo sem 9 → alternativo com 9
  }
  return [e164] // fixo
}
```
Em `packages/db/src/index.ts`, acrescentar:
```ts
export { canonicalizePhone, phoneMatchCandidates, type CanonicalPhone } from './phone.js'
```

- [ ] **Step 4: Rodar e ver passar** — testes db verdes + typecheck.

- [ ] **Step 5: Commit** — `git commit -m "feat(db): telefone canonico E.164 com regra do 9o digito (Domain.md)"`

---

### Task 4: Evolution dedicada no EasyPanel + instância do piloto (CHECKPOINT com o usuário)

**Files:**
- Modify: `.env`, `.env.example` (novas vars `EVOLUTION_DEV_*`)
- Nenhum código de produto — infra + coordenação.

**Interfaces:**
- Produces: Evolution API dev no ar em `https://aios-pocket-evolution-dev.yspmhc.easypanel.host` com API key `<EVOLUTION_API_KEY>`; instância `aios-pocket` criada e CONECTADA (QR escaneado pelo usuário); vars `EVOLUTION_DEV_BASE_URL`, `EVOLUTION_DEV_API_KEY`, `EVOLUTION_DEV_INSTANCE` no `.env`. As tasks 5+ usam SEMPRE a instância dev — as vars `EVOLUTION_*` antigas (produção `murilo`) ficam no `.env` mas NÃO são usadas por código.

- [ ] **Step 1: Criar o database `evolution` no postgres-dev**

Run (da raiz):
```bash
echo 'CREATE DATABASE evolution;' | pnpm --filter @aios-pocket/db exec prisma db execute --stdin --url "postgresql://postgres:<SENHA_PG_ROTACIONADA>@143.198.98.6:5433/postgres"
```
Expected: sucesso silencioso. (Se já existir, erro "already exists" é aceitável — seguir.)

- [ ] **Step 2: Entregar o schema ao usuário para colar no EasyPanel**

Apresentar ao usuário (checkpoint — aguardar ele confirmar a criação):

```json
{
  "services": [
    {
      "type": "app",
      "data": {
        "projectName": "aios-pocket",
        "serviceName": "evolution-dev",
        "source": { "type": "image", "image": "evoapicloud/evolution-api:latest" },
        "env": "SERVER_URL=https://aios-pocket-evolution-dev.yspmhc.easypanel.host\r\nAUTHENTICATION_API_KEY=<EVOLUTION_API_KEY>\r\nAUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true\r\nDATABASE_ENABLED=true\r\nDATABASE_PROVIDER=postgresql\r\nDATABASE_CONNECTION_URI=postgres://postgres:<SENHA_PG_ROTACIONADA>@aios-pocket_postgres-dev:5432/evolution\r\nDATABASE_CONNECTION_CLIENT_NAME=aios-pocket-dev\r\nCACHE_REDIS_ENABLED=true\r\nCACHE_REDIS_URI=redis://default:<SENHA_REDIS_ROTACIONADA>@aios-pocket_redis-dev:6379/3\r\nCACHE_REDIS_PREFIX_KEY=evolution-dev\r\nCACHE_REDIS_SAVE_INSTANCES=false\r\nCACHE_LOCAL_ENABLED=false\r\nCONFIG_SESSION_PHONE_CLIENT=chrome\r\nCONFIG_SESSION_PHONE_NAME=Chrome\r\nQRCODE_LIMIT=5\r\nDEL_INSTANCE=false\r\nLANGUAGE=pt-BR",
        "deploy": { "replicas": 1, "command": null, "zeroDowntime": true },
        "domains": [
          {
            "host": "aios-pocket-evolution-dev.yspmhc.easypanel.host",
            "https": true,
            "port": 8080,
            "path": "/",
            "wildcard": false,
            "internalProtocol": "http"
          }
        ]
      }
    }
  ]
}
```
Instruir também: aba **Recursos** do `evolution-dev` → limite de memória **1024 MB** (blindagem da produção no mesmo droplet).

- [ ] **Step 3: Verificar a Evolution dev no ar**

Run: `curl -s https://aios-pocket-evolution-dev.yspmhc.easypanel.host/ -H 'apikey: <EVOLUTION_API_KEY>'`
Expected: JSON de boas-vindas com a versão. (Domínio pode variar se o EasyPanel sugerir outro — usar o real e registrar.)

- [ ] **Step 4: Criar a instância do piloto e obter o QR**

```bash
curl -s -X POST 'https://aios-pocket-evolution-dev.yspmhc.easypanel.host/instance/create' \
  -H 'apikey: <EVOLUTION_API_KEY>' -H 'Content-Type: application/json' \
  -d '{"instanceName":"aios-pocket","integration":"WHATSAPP-BAILEYS","qrcode":true}'
```
A resposta traz `qrcode.base64` (data URI PNG). Salvar como imagem (`[Convert]::FromBase64String` no PowerShell, tirando o prefixo `data:image/png;base64,`) em `C:\Users\Usuario\Desktop\CRM\qr-aios-pocket.png` e AVISAR o usuário para escanear (WhatsApp → Aparelhos conectados). ATENÇÃO ao instruir o usuário: escanear preferencialmente com um número que NÃO seja o do `murilo` — o mesmo número em duas instâncias Baileys pode gerar conflito de dispositivo (`device_removed`, já aconteceu nesse servidor). Se o QR expirar, `GET /instance/connect/aios-pocket` gera outro.

- [ ] **Step 5: Confirmar conexão (aguardar o scan do usuário)**

Run: `curl -s 'https://aios-pocket-evolution-dev.yspmhc.easypanel.host/instance/connectionState/aios-pocket' -H 'apikey: <EVOLUTION_API_KEY>'`
Expected: `{"instance":{"instanceName":"aios-pocket","state":"open"}}`.

- [ ] **Step 6: Registrar env e commitar o .env.example**

Acrescentar ao `.env` (real) e ao `.env.example` (sem valores):
```
# Evolution DEDICADA de dev (projeto aios-pocket no EasyPanel) — a de produção (murilo) é INTOCÁVEL
EVOLUTION_DEV_BASE_URL=https://aios-pocket-evolution-dev.yspmhc.easypanel.host
EVOLUTION_DEV_API_KEY=<EVOLUTION_API_KEY>
EVOLUTION_DEV_INSTANCE=aios-pocket
```
Atualizar também as credenciais cifradas do seed: em `packages/db/prisma/seed.ts`, o bloco `evolution` passa a ler `EVOLUTION_DEV_*` (baseUrl, apiKey, instanceId=EVOLUTION_DEV_INSTANCE). Rodar `pnpm --filter @aios-pocket/db run db:seed` para recifrar.
```bash
git add .env.example packages/db/prisma/seed.ts
git commit -m "feat: instancia Evolution dedicada de dev — env e seed apontam para ela (producao intocada)"
```

---

### Task 5: `packages/providers` — contrato MessagingProvider + EvolutionProvider (envio + status)

**Files:**
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`, `packages/providers/src/index.ts`, `packages/providers/src/types.ts`, `packages/providers/src/evolution/provider.ts`, `packages/providers/src/evolution/http.ts`
- Test: `packages/providers/test/evolution-send.test.ts` (integração REAL contra a instância dev)

**Interfaces:**
- Consumes: tipos de `@aios-pocket/contracts`; instância dev conectada (Task 4).
- Produces (consumidos por Tasks 9-12 e pelo Plano D):
  - `interface MessagingProvider { sendText(to: string, text: string): Promise<SendResult>; sendMedia(to: string, media: OutboundMedia): Promise<SendResult>; parseWebhook(raw: unknown): NormalizedWebhookEvent | null; getConnectionStatus(): Promise<'connected' | 'disconnected' | 'connecting'> }`
  - `type SendResult = { providerMessageId: string }`
  - `type OutboundMedia = { url: string; mimeType: string; caption?: string }`
  - `type EvolutionConfig = { baseUrl: string; apiKey: string; instanceId: string }`
  - `createEvolutionProvider(config: EvolutionConfig): MessagingProvider` — `parseWebhook` NESTA task lança `Error('parseWebhook: implementado na Task 9 sobre fixtures reais')`; o resto é real.
- O package NÃO importa nada de `packages/db` (fronteira: providers só conhecem config já decifrada).

- [ ] **Step 1: Package + teste de integração que falha**

`packages/providers/package.json`:
```json
{
  "name": "@aios-pocket/providers",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "dotenv -e ../../.env -- vitest run"
  },
  "dependencies": {
    "@aios-pocket/contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "dotenv-cli": "^8.0.0",
    "vitest": "^3.0.0"
  }
}
```
`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`

`packages/providers/test/evolution-send.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createEvolutionProvider } from '../src/index.js'

// Integração REAL contra a instância dev dedicada (Task 4). Envia mensagem para o
// PRÓPRIO número conectado (mensagem para si mesmo — sem incomodar terceiros).
// Pula quando as vars não existem (ex.: CI, que não conhece a Evolution dev).
const baseUrl = process.env.EVOLUTION_DEV_BASE_URL
const apiKey = process.env.EVOLUTION_DEV_API_KEY
const instanceId = process.env.EVOLUTION_DEV_INSTANCE
const runIf = baseUrl && apiKey && instanceId ? describe : describe.skip

runIf('EvolutionProvider (integração real, instância dev)', () => {
  const provider = createEvolutionProvider({
    baseUrl: baseUrl as string,
    apiKey: apiKey as string,
    instanceId: instanceId as string,
  })

  it('getConnectionStatus reporta connected', async () => {
    expect(await provider.getConnectionStatus()).toBe('connected')
  }, 20000)

  it('sendText para o próprio número retorna providerMessageId', async () => {
    const status = await provider.getConnectionStatus()
    expect(status).toBe('connected')
    const self = process.env.EVOLUTION_DEV_SELF_PHONE
    if (!self) throw new Error('defina EVOLUTION_DEV_SELF_PHONE no .env (número conectado, só dígitos)')
    const result = await provider.sendText(self, `teste aios-pocket ${new Date().toISOString()}`)
    expect(result.providerMessageId.length).toBeGreaterThan(5)
  }, 30000)
})
```
(Após o scan da Task 4, preencher `EVOLUTION_DEV_SELF_PHONE` no `.env` com o número conectado — visível no `fetchInstances` como `ownerJid`.)

- [ ] **Step 2: Rodar e ver falhar** — módulo inexistente.

- [ ] **Step 3: Implementar**

`packages/providers/src/types.ts`:
```ts
import type { NormalizedWebhookEvent } from '@aios-pocket/contracts'

export interface SendResult {
  providerMessageId: string
}

export interface OutboundMedia {
  url: string
  mimeType: string
  caption?: string
}

// Contrato único (ADR-0002): nenhum módulo de negócio conhece Evolution ou Z-API.
export interface MessagingProvider {
  sendText(to: string, text: string): Promise<SendResult>
  sendMedia(to: string, media: OutboundMedia): Promise<SendResult>
  parseWebhook(raw: unknown): NormalizedWebhookEvent | null
  getConnectionStatus(): Promise<'connected' | 'disconnected' | 'connecting'>
}

export interface EvolutionConfig {
  baseUrl: string
  apiKey: string
  instanceId: string
}
```

`packages/providers/src/evolution/http.ts`:
```ts
import type { EvolutionConfig } from '../types.js'

// Cliente HTTP mínimo da Evolution v2. Único lugar do produto que fala com a API dela.
export async function evolutionRequest<T>(
  config: EvolutionConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`evolution ${method} ${path} falhou: ${res.status} ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}
```

`packages/providers/src/evolution/provider.ts`:
```ts
import type { NormalizedWebhookEvent } from '@aios-pocket/contracts'
import type { EvolutionConfig, MessagingProvider, OutboundMedia, SendResult } from '../types.js'
import { evolutionRequest } from './http.js'

interface EvolutionSendResponse {
  key?: { id?: string }
}

interface EvolutionConnectionState {
  instance?: { state?: string }
}

export function createEvolutionProvider(config: EvolutionConfig): MessagingProvider {
  return {
    async sendText(to: string, text: string): Promise<SendResult> {
      const res = await evolutionRequest<EvolutionSendResponse>(
        config,
        'POST',
        `/message/sendText/${config.instanceId}`,
        { number: to, text },
      )
      const id = res.key?.id
      if (!id) throw new Error('evolution sendText sem key.id na resposta')
      return { providerMessageId: id }
    },

    async sendMedia(to: string, media: OutboundMedia): Promise<SendResult> {
      const res = await evolutionRequest<EvolutionSendResponse>(
        config,
        'POST',
        `/message/sendMedia/${config.instanceId}`,
        {
          number: to,
          mediatype: media.mimeType.startsWith('image/') ? 'image' : media.mimeType.startsWith('video/') ? 'video' : media.mimeType.startsWith('audio/') ? 'audio' : 'document',
          mimetype: media.mimeType,
          media: media.url,
          caption: media.caption ?? '',
        },
      )
      const id = res.key?.id
      if (!id) throw new Error('evolution sendMedia sem key.id na resposta')
      return { providerMessageId: id }
    },

    parseWebhook(_raw: unknown): NormalizedWebhookEvent | null {
      // Implementado na Task 9, com TDD sobre fixtures REAIS capturadas nas Tasks 7-8.
      // Fixture inventada é proibida (Conventions.md) — por isso o stub lança.
      throw new Error('parseWebhook: implementado na Task 9 sobre fixtures reais')
    },

    async getConnectionStatus(): Promise<'connected' | 'disconnected' | 'connecting'> {
      const res = await evolutionRequest<EvolutionConnectionState>(
        config,
        'GET',
        `/instance/connectionState/${config.instanceId}`,
      )
      const state = res.instance?.state
      if (state === 'open') return 'connected'
      if (state === 'connecting') return 'connecting'
      return 'disconnected'
    },
  }
}
```

`packages/providers/src/index.ts`:
```ts
export type { MessagingProvider, SendResult, OutboundMedia, EvolutionConfig } from './types.js'
export { createEvolutionProvider } from './evolution/provider.js'
```

- [ ] **Step 4: Ver passar (o teste manda mensagem REAL para o próprio número)**

Run: `pnpm install`, preencher `EVOLUTION_DEV_SELF_PHONE` no `.env`, `pnpm --filter @aios-pocket/providers test`
Expected: 2 testes verdes; a mensagem "teste aios-pocket ..." chega no WhatsApp do piloto (confirmar com o usuário). Se a rota `sendText` retornar 404, consultar a versão da Evolution instalada e ajustar o path conforme a doc v2 real, registrando no report.

- [ ] **Step 5: Turbo env + commit**

Adicionar `EVOLUTION_DEV_BASE_URL`, `EVOLUTION_DEV_API_KEY`, `EVOLUTION_DEV_INSTANCE`, `EVOLUTION_DEV_SELF_PHONE` à lista `tasks.test.env` do `turbo.json` (o teste os consome; no CI ausentes = describe.skip, comportamento correto).
```bash
git add packages/providers turbo.json pnpm-lock.yaml .env.example
git commit -m "feat(providers): contrato MessagingProvider e EvolutionProvider de envio/status (ADR-0002)"
```

---

### Task 6: Webhook token + endpoints de arquivamento + repo de company pré-tenant

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (coluna nova), `packages/db/prisma/seed.ts`, `packages/db/src/index.ts`
- Create: migração `*_webhook_token`, `packages/db/src/repositories/companies.ts`, `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/app.ts` (registrar rotas)
- Test: `packages/db/test/companies-repo.test.ts`, `apps/api/test/webhooks-archive.test.ts`

**Interfaces:**
- Consumes: `RawWebhookEvent` (tenant-exempt), fila `webhook-processing` (Plano A).
- Produces (consumidos por Tasks 7-10):
  - Coluna `companies.webhook_token` (`String @unique @map("webhook_token")`, default `uuid()`).
  - `companiesRepo.findByWebhookToken(token)` e `companiesRepo.findById(id)` — repositório PRÉ-TENANT sancionado (mesmo padrão do `resolveUserByAuthId`; comentário explica: webhooks autenticam por token, não por JWT).
  - `POST /webhooks/evolution/:webhookToken` e `POST /webhooks/zapi/:webhookToken`: resolvem a company pelo token (404 se inválido), arquivam o payload CRU em `raw_webhook_events` (SEMPRE, antes de qualquer parse), respondem `200 {received:true}` imediatamente e enfileiram `webhook-processing` com `{ rawEventId, provider, companyId }` (jobId = rawEventId). Não existe worker consumidor ainda — os jobs acumulam na fila, correto até a Task 10.

- [ ] **Step 1: Migração da coluna**

No model `Company` do schema.prisma, após `providerCredentials`:
```prisma
  webhookToken        String          @unique @default(uuid()) @map("webhook_token")
```
Run: `pnpm --filter @aios-pocket/db run db:migrate -- --name webhook_token` (banco remoto dev). Commit referencia ADR-0003 (autenticação de webhook por token de company).

- [ ] **Step 2: Testes que falham**

`packages/db/test/companies-repo.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { prismaUnsafe } from '../src/unsafe.js'
import { companiesRepo } from '../src/repositories/companies.js'

let token = ''
let companyId = ''

beforeAll(async () => {
  const company = await prismaUnsafe.company.create({
    data: { name: `Webhook Teste ${Date.now()}`, activeProvider: 'evolution', providerCredentials: 'cifrado' },
  })
  token = company.webhookToken
  companyId = company.id
})

describe('companiesRepo (pré-tenant: webhooks autenticam por token)', () => {
  it('resolve company por webhook token', async () => {
    const found = await companiesRepo.findByWebhookToken(token)
    expect(found?.id).toBe(companyId)
  })
  it('token desconhecido retorna null', async () => {
    expect(await companiesRepo.findByWebhookToken('11111111-1111-1111-1111-111111111111')).toBeNull()
  })
})
```

`apps/api/test/webhooks-archive.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prismaUnsafe } from '@aios-pocket/db/testing'
import { buildApp } from '../src/app.js'

const app = buildApp()
let webhookToken: string | undefined
let companyId: string | undefined

beforeAll(async () => {
  const company = await prismaUnsafe.company.create({
    data: { name: `Webhook Arquivo ${Date.now()}`, activeProvider: 'evolution', providerCredentials: 'cifrado' },
  })
  webhookToken = company.webhookToken
  companyId = company.id
})

afterAll(async () => {
  if (companyId) {
    await prismaUnsafe.rawWebhookEvent.deleteMany({ where: { companyId } })
    await prismaUnsafe.company.deleteMany({ where: { id: companyId } })
  }
  await app.close()
})

describe('arquivamento de webhook (ADR-0003: payload cru nunca se perde)', () => {
  it('POST /webhooks/evolution/:token arquiva o payload cru e responde 200 rápido', async () => {
    if (!webhookToken || !companyId) throw new Error('fixture não criada')
    const payload = { event: 'messages.upsert', instance: 'aios-pocket', data: { qualquer: 'coisa' } }
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/evolution/${webhookToken}`,
      payload,
    })
    expect(res.statusCode).toBe(200)
    const archived = await prismaUnsafe.rawWebhookEvent.findFirst({ where: { companyId } })
    expect(archived?.provider).toBe('evolution')
    expect(archived?.processed).toBe(false)
    expect((archived?.payload as { event: string }).event).toBe('messages.upsert')
  })

  it('token inválido responde 404 sem arquivar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution/11111111-1111-1111-1111-111111111111',
      payload: { x: 1 },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 3: Rodar e ver falhar**, depois implementar

`packages/db/src/repositories/companies.ts`:
```ts
import { prismaUnsafe } from '../unsafe.js'

// PRÉ-TENANT sancionado (como resolveUserByAuthId): o webhook autentica a company
// pelo token da URL — não existe JWT/tenant antes dessa resolução (ADR-0003).
export const companiesRepo = {
  findByWebhookToken(webhookToken: string) {
    return prismaUnsafe.company.findUnique({ where: { webhookToken } })
  },
  findById(id: string) {
    return prismaUnsafe.company.findUnique({ where: { id } })
  },
}
```
Export no `packages/db/src/index.ts`: `export { companiesRepo } from './repositories/companies.js'`.

`apps/api/src/routes/webhooks.ts` (o arquivamento usa o client tenantizado `prisma`, que JÁ isenta `RawWebhookEvent` — NUNCA importar `@aios-pocket/db/testing` em código de produção):
```ts
import type { FastifyInstance } from 'fastify'
import { companiesRepo, prisma } from '@aios-pocket/db'
import { webhookProcessingQueue } from '../queue/queues.js'

const PROVIDERS = ['evolution', 'zapi'] as const
type ProviderParam = (typeof PROVIDERS)[number]

// Arquiva ANTES de qualquer parse e responde 200 imediato (ADR-0003):
// payload cru nunca se perde; processamento é assíncrono via BullMQ.
export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post<{ Params: { provider: string; webhookToken: string } }>(
    '/webhooks/:provider/:webhookToken',
    async (req, reply) => {
      const provider = req.params.provider as ProviderParam
      if (!PROVIDERS.includes(provider)) return reply.code(404).send({ error: 'provider desconhecido' })
      const company = await companiesRepo.findByWebhookToken(req.params.webhookToken)
      if (!company) return reply.code(404).send({ error: 'token desconhecido' })

      const raw = await prisma.rawWebhookEvent.create({
        data: { provider, companyId: company.id, payload: req.body as object },
      })
      await webhookProcessingQueue.add(
        'process',
        { rawEventId: raw.id, provider, companyId: company.id },
        { jobId: raw.id },
      )
      return reply.code(200).send({ received: true })
    },
  )
}
```
Nota de implementação: `RawWebhookEvent` está em `TENANT_EXEMPT_MODELS`, então `prisma.rawWebhookEvent.create` funciona sem TenantContext — exatamente o desenho do ADR-0001. `create` é operação permitida para modelo isento (o guard de operações proibidas roda só para modelos tenantizados — conferir em `packages/db/src/client.ts`; se o exempt check vier depois do forbidden check, inverter é BUG do Plano A já corrigido — o exempt vem primeiro).

Em `apps/api/src/app.ts`, depois das rotas existentes: `registerWebhookRoutes(app)` (import no topo). Os prefixos públicos já cobrem `/webhooks/`.

- [ ] **Step 4: Ver passar** — db + api verdes; typecheck; lint.

- [ ] **Step 5: Commit** — `git commit -m "feat: webhook token por company, endpoints de arquivamento e repo pre-tenant (ADR-0003)"`

---

### Task 7: Túnel + captura ao vivo de payloads reais (CHECKPOINT com o usuário)

**Files:**
- Nenhum código novo — operação coordenada. Registro em `docs/superpowers/notes/2026-XX-XX-captura-evolution.md` (data real).

**Interfaces:**
- Consumes: endpoints da Task 6, instância dev conectada (Task 4).
- Produces: dezenas de linhas em `raw_webhook_events` cobrindo o roteiro abaixo — a matéria-prima das fixtures (Task 8).

- [ ] **Step 1: Subir API local + túnel**

Run em background: `pnpm --filter @aios-pocket/api dev` e `cloudflared tunnel --url http://localhost:3001` (instalar cloudflared via `winget install Cloudflare.cloudflared` se ausente — checar antes). Capturar a URL pública `https://<aleatorio>.trycloudflare.com`.

- [ ] **Step 2: Apontar o webhook DA INSTÂNCIA DEV para o túnel**

Obter o `webhookToken` da company piloto (`Aios Pocket`) via query. Depois:
```bash
curl -s -X POST 'https://aios-pocket-evolution-dev.yspmhc.easypanel.host/webhook/set/aios-pocket' \
  -H 'apikey: <EVOLUTION_API_KEY>' -H 'Content-Type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"https://<tunel>.trycloudflare.com/webhooks/evolution/<webhookToken>","webhookByEvents":false,"events":["MESSAGES_UPSERT","MESSAGES_UPDATE","SEND_MESSAGE","CONNECTION_UPDATE"]}}'
```
(SÓ a instância dev `aios-pocket` — JAMAIS a `murilo`.) Se o shape `{"webhook":{...}}` falhar na versão instalada, tentar o shape plano `{"enabled":...}` e registrar.

- [ ] **Step 3: Roteiro de captura com o usuário (checkpoint)**

Pedir ao usuário que, de um SEGUNDO número (ou peça a alguém), envie PARA o número do piloto — e vice-versa — nesta ordem, avisando a cada item:
1. Texto simples (inbound)
2. Resposta digitada NO CELULAR do piloto (fromMe — o histórico não pode mentir)
3. Áudio (inbound)
4. Imagem com legenda (inbound)
5. Documento/PDF (inbound)
6. Reply/quote citando uma mensagem anterior (inbound)
7. Edição de uma mensagem já enviada (inbound editada)
8. Envio via API: `provider.sendText` (script curto) → observar os acks (sent/delivered/read) chegando como webhooks
9. Desconectar e reconectar a instância (gera CONNECTION_UPDATE) — via painel da Evolution dev, `logout` + novo QR

Conferir no banco a cada passo: `SELECT provider, processed, payload->>'event', received_at FROM raw_webhook_events ORDER BY received_at DESC LIMIT 5` (via prisma db execute ou script node). Meta: >= 15 eventos cobrindo os 9 itens.

- [ ] **Step 4: Registrar** — escrever a nota de captura (o que foi capturado, ids dos raw events por categoria) e desligar o túnel. Commit da nota.

---

### Task 8: Sanitização + fixtures reais commitadas

**Files:**
- Create: `scripts/harvest-fixtures.ts` (raiz), `tests/providers/fixtures/evolution/*.json` (gerados), `tests/providers/fixtures/README.md`
- Modify: `package.json` raiz (script `fixtures:harvest`)

**Interfaces:**
- Consumes: `raw_webhook_events` populada (Task 7).
- Produces: fixtures sanitizadas em `tests/providers/fixtures/evolution/` com manifesto `manifest.json` (`[{ file, kind }]`, kind = categoria esperada: `incoming_text`, `incoming_from_me`, `incoming_audio`, `incoming_image`, `incoming_document`, `incoming_reply`, `incoming_edit`, `status_update`, `connection_update`) — a Task 9 constrói o parser sobre isso.

- [ ] **Step 1: Ferramenta de sanitização**

`scripts/harvest-fixtures.ts` (rodado com `dotenv -e .env -- tsx scripts/harvest-fixtures.ts`):
```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prismaUnsafe } from '../packages/db/src/testing.js'

// Sanitização OBRIGATÓRIA (spec §11): telefones e nomes reais trocados por valores
// sintéticos ESTÁVEIS (mesmo original → mesmo substituto, preservando correlações),
// mídia base64 truncada. Payload cru real nunca é commitado sem passar por aqui.
const phoneMap = new Map<string, string>()
let phoneSeq = 0

function syntheticPhone(real: string): string {
  const existing = phoneMap.get(real)
  if (existing) return existing
  phoneSeq += 1
  const synthetic = `5511${String(999990000 + phoneSeq)}`
  phoneMap.set(real, synthetic)
  return synthetic
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value.replace(/\d{12,13}(?=@s\.whatsapp\.net|@g\.us|$)/g, (m) => syntheticPhone(m))
    out = out.replace(/^[A-Za-z0-9+/=]{500,}$/g, '[BASE64_REMOVIDO]')
    return out
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (k === 'pushName' || k === 'profileName') return [k, 'Cliente Teste']
      return [k, sanitize(v)]
    })
    return Object.fromEntries(entries)
  }
  return value
}

async function main(): Promise<void> {
  const events = await prismaUnsafe.rawWebhookEvent.findMany({
    where: { provider: 'evolution' },
    orderBy: { receivedAt: 'asc' },
  })
  const dir = join(process.cwd(), 'tests', 'providers', 'fixtures', 'evolution')
  mkdirSync(dir, { recursive: true })
  events.forEach((event, index) => {
    const name = `${String(index + 1).padStart(3, '0')}-raw.json`
    writeFileSync(join(dir, name), `${JSON.stringify(sanitize(event.payload), null, 2)}\n`)
  })
  console.log(`${events.length} fixtures escritas em ${dir} — classifique o manifest.json manualmente`)
}

main().finally(() => prismaUnsafe.$disconnect())
```

- [ ] **Step 2: Rodar, classificar e revisar**

Run: `pnpm exec dotenv -e .env -- tsx scripts/harvest-fixtures.ts`. Depois: renomear cada arquivo para `<kind>-<n>.json` conforme o conteúdo (ex.: `incoming_text-1.json`), escrever `manifest.json` listando `{ "file": "...", "kind": "..." }` para cada um, e INSPECIONAR cada fixture confirmando que nenhum telefone/nome real sobrou (busca por dígitos do número do piloto). `README.md` explica a regra: todo bug de provider vira fixture; toda fixture vira teste.

- [ ] **Step 3: Commit** — `git add tests/providers scripts package.json && git commit -m "feat: fixtures reais sanitizadas da Evolution (patrimônio técnico — Conventions.md)"`

---

### Task 9: `parseWebhook` da Evolution — TDD sobre as fixtures reais (suíte de contrato)

**Files:**
- Create: `packages/providers/src/evolution/parse.ts`, `packages/providers/test/contract-suite.ts`, `packages/providers/test/evolution-parse.test.ts`
- Modify: `packages/providers/src/evolution/provider.ts` (parseWebhook real)

**Interfaces:**
- Consumes: fixtures + manifest (Task 8), tipos de `@aios-pocket/contracts`.
- Produces: `parseWebhook(raw)` retornando `IncomingMessage | MessageStatusUpdate | ConnectionStatusChange | null` (null = evento irrelevante, ex.: grupo/ack desconhecido — nunca throw em payload estranho; retorna null e o worker marca o raw como processado-ignorado); `runProviderContractSuite(provider, fixturesDir)` — a MESMA suíte que o ZApiProvider terá que passar no Plano D (critério da Fatia 4).

- [ ] **Step 1: Suíte de contrato dirigida pelo manifest (falha primeiro)**

`packages/providers/test/contract-suite.ts`:
```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MessagingProvider } from '../src/index.js'

interface ManifestEntry {
  file: string
  kind:
    | 'incoming_text'
    | 'incoming_from_me'
    | 'incoming_audio'
    | 'incoming_image'
    | 'incoming_document'
    | 'incoming_reply'
    | 'incoming_edit'
    | 'status_update'
    | 'connection_update'
}

// Suíte de contrato provider-agnóstica (ADR-0002): a MESMA bateria roda para
// Evolution (agora) e Z-API (Plano D). Critério da Fatia 4: passar aqui.
export function runProviderContractSuite(provider: MessagingProvider, fixturesDir: string): void {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8')) as ManifestEntry[]

  describe(`contrato de provider sobre ${manifest.length} fixtures reais`, () => {
    it('manifest cobre todas as categorias obrigatórias', () => {
      const kinds = new Set(manifest.map((m) => m.kind))
      for (const required of ['incoming_text', 'incoming_from_me', 'incoming_audio', 'incoming_reply', 'incoming_edit', 'status_update', 'connection_update']) {
        expect(kinds, `categoria ${required} sem fixture — capture-a antes`).toContain(required)
      }
    })

    it('toda fixture do diretório está no manifest', () => {
      const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
      expect(files.sort()).toEqual(manifest.map((m) => m.file).sort())
    })

    for (const entry of manifest) {
      it(`${entry.file} → ${entry.kind}`, () => {
        const raw = JSON.parse(readFileSync(join(fixturesDir, entry.file), 'utf8')) as unknown
        const parsed = provider.parseWebhook(raw)
        expect(parsed, 'payload real não pode virar null nas categorias mapeadas').not.toBeNull()
        if (!parsed) return
        if (entry.kind.startsWith('incoming')) {
          expect(parsed.kind).toBe('incoming_message')
          if (parsed.kind !== 'incoming_message') return
          expect(parsed.providerMessageId.length).toBeGreaterThan(3)
          expect(parsed.phone.length).toBeGreaterThan(7)
          expect(parsed.conversationExternalId.length).toBeGreaterThan(3)
          if (entry.kind === 'incoming_from_me') expect(parsed.fromMe).toBe(true)
          if (entry.kind === 'incoming_audio' || entry.kind === 'incoming_image' || entry.kind === 'incoming_document') {
            expect(parsed.media, 'mídia precisa de referência/chave de correlação').not.toBeNull()
          }
          if (entry.kind === 'incoming_reply') expect(parsed.replyToProviderMessageId).not.toBeNull()
          if (entry.kind === 'incoming_edit') expect(parsed.isEdit).toBe(true)
        }
        if (entry.kind === 'status_update') expect(parsed.kind).toBe('message_status_update')
        if (entry.kind === 'connection_update') expect(parsed.kind).toBe('connection_status_change')
      })
    }

    it('payload desconhecido retorna null, nunca lança', () => {
      expect(provider.parseWebhook({ event: 'algo.novo.desconhecido', data: {} })).toBeNull()
      expect(provider.parseWebhook('lixo')).toBeNull()
      expect(provider.parseWebhook(null)).toBeNull()
    })
  })
}
```

`packages/providers/test/evolution-parse.test.ts`:
```ts
import { join } from 'node:path'
import { createEvolutionProvider } from '../src/index.js'
import { runProviderContractSuite } from './contract-suite.js'

const provider = createEvolutionProvider({ baseUrl: 'https://exemplo.invalido', apiKey: 'x', instanceId: 'x' })
runProviderContractSuite(provider, join(import.meta.dirname, '..', '..', '..', 'tests', 'providers', 'fixtures', 'evolution'))
```

- [ ] **Step 2: RED** — a suíte falha no stub que lança.

- [ ] **Step 3: Implementar `parse.ts` contra as fixtures REAIS**

O implementador escreve `packages/providers/src/evolution/parse.ts` mapeando os shapes REAIS observados nas fixtures (não os da doc): `messages.upsert` → IncomingMessage (extraindo `key.id`, `key.remoteJid`, `key.fromMe`, `pushName`, tipo pela presença de `conversation`/`audioMessage`/`imageMessage`/`documentMessage`, legenda, `contextInfo.stanzaId` para reply, `editedMessage`/protocolMessage para edição, URL/mimetype de mídia como referência + `key.id` como correlationKey); `messages.update` → MessageStatusUpdate (mapear `status`/ack para sent/delivered/read); `connection.update` → ConnectionStatusChange. Campos exatos saem das fixtures — é por isso que elas vêm antes. `provider.ts` delega: `parseWebhook: (raw) => parseEvolutionWebhook(raw)`.

- [ ] **Step 4: GREEN + commit** — suíte inteira verde; `git commit -m "feat(providers): parseWebhook da Evolution via TDD sobre fixtures reais (ADR-0003)"`

---

### Task 10: Pipeline inbound — worker `webhook-processing`

**Files:**
- Create: `apps/api/src/pipeline/process-webhook.ts`, `apps/api/src/pipeline/resolve-customer.ts`, `apps/api/src/pipeline/apply-status.ts`, `apps/api/src/queue/webhook-worker.ts`
- Modify: `apps/api/src/server.ts` (start do worker), `packages/db/src/repositories/customers.ts` (matching por candidatos), `packages/db/src/index.ts`
- Test: `apps/api/test/pipeline-inbound.test.ts` (integração com fixtures reais → banco dev)

**Interfaces:**
- Consumes: fixtures (asserções de ponta a ponta), `parseWebhook` (Task 9), `canonicalizePhone`/`phoneMatchCandidates` (Task 3), repos do Plano A, `companiesRepo` (Task 6), `publishDomainEvent`.
- Produces: worker que consome `webhook-processing`; use case `processRawWebhook(rawEventId)` — TODO o processamento roda `runWithTenant({ companyId })`:
  1. Carrega o raw; se `processed`, retorna (idempotente).
  2. `parseWebhook`; `null` → marca `processed=true, error='ignorado'` e retorna.
  3. `IncomingMessage`: dedupe pela unique de Message; resolve/cria Customer (`customersRepo.findByPhoneCandidates` — busca por `phoneMatchCandidates`, cria com E.164 canônico se nenhum bate); resolve/cria Conversation (`companyId+provider+conversationExternalId`, atualiza `lastMessageAt`); insere Message (`direction` = fromMe ? outbound : inbound, `state` = fromMe ? sent : received, campos de mídia/reply); edição (`isEdit`) → localiza a Message original por providerMessageId e grava `editedText` (original preservado); TimelineEvent `message_received`/`message_sent_from_phone` + `publishDomainEvent('MessageReceived', ...)` após o commit.
  4. `MessageStatusUpdate`: máquina de estados (`apply-status.ts` — só avança: sent→delivered→read; nunca regride; failed é terminal), TimelineEvent da transição.
  5. `ConnectionStatusChange`: atualiza `companies.connectionState` + TimelineEvent + `publishDomainEvent('ConnectionChanged', ...)` — instância morta NUNCA em silêncio.
  6. Marca `processed=true`. Erros de processamento NÃO marcam processed (job falha → retry BullMQ, `attempts: 3`, backoff exponencial; esgotou → fica na fila de falhas para inspeção).

- [ ] **Step 1: Teste de integração que falha** — `apps/api/test/pipeline-inbound.test.ts` cria company própria (via `@aios-pocket/db/testing`), injeta cada fixture de `incoming_*` pelo endpoint real (`app.inject POST /webhooks/evolution/:token`), roda `processRawWebhook` diretamente (sem esperar worker — determinístico) e assert: Customer criado com E.164; segunda fixture do MESMO telefone não duplica Customer; fromMe vira outbound/sent; reply carrega `replyToProviderMessageId`; edição preenche `editedText` da original; status_update move o estado; connection_update muda `connectionState` da company; reprocessar o MESMO raw é no-op (idempotência). Cleanup escopado por companyId criado (com guarda `if`, lição do Plano A).

- [ ] **Step 2: RED → implementar** os arquivos listados. `customersRepo` ganha:
```ts
findByPhoneCandidates(candidates: string[]) {
  return prisma.customer.findFirst({ where: { phoneE164: { in: candidates } } })
}
```
`webhook-worker.ts` segue o padrão do domain-events worker (conexão de worker, `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }` no `add` da rota — ajustar a Task 6 se necessário) e chama `processRawWebhook(job.data.rawEventId)`. `server.ts` inicia ambos os workers.

- [ ] **Step 3: GREEN + gate completo + commit** — `git commit -m "feat(api): pipeline inbound completo — webhook vira Customer/Conversation/Message/Timeline (ADR-0004/0006)"`

---

### Task 11: Envio — rota autenticada + worker `message-send`

**Files:**
- Create: `packages/contracts/src/api.ts` (schema do request), `apps/api/src/routes/messages.ts`, `apps/api/src/queue/send-worker.ts`, `apps/api/src/pipeline/send-message.ts`, `apps/api/src/provider-factory.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/server.ts`, `packages/contracts/src/index.ts`
- Test: `apps/api/test/send-flow.test.ts`

**Interfaces:**
- Consumes: `decryptJson` (credenciais), `createEvolutionProvider`, fila `message-send`, tenancy.
- Produces:
  - `sendMessageRequestSchema = z.object({ conversationId: z.uuid(), text: z.string().min(1).max(4096) })` em contracts (validação compartilhada web/api — regra do CLAUDE.md).
  - `POST /messages` (autenticada): valida com o schema, confere que a Conversation é do tenant, cria Message `queued` (direction outbound, correlationId novo), enfileira `message-send` (`jobId` = message.id, `attempts: 3`, backoff exponencial) e responde `202 { messageId }` — rota NUNCA espera provider.
  - `providerFactoryForCompany(company)` em `provider-factory.ts`: `decryptJson` das credenciais + `activeProvider` → `createEvolutionProvider(config.evolution)`; `zapi` → `throw new Error('ZApiProvider: Plano D')`. Único lugar que liga db⇄providers.
  - `send-worker.ts`: carrega Message+Conversation+Customer `runWithTenant`; estado `sending`; `provider.sendText(customer.phoneE164 sem '+', text)`; sucesso → `sent` + `providerMessageId` + TimelineEvent + `publishDomainEvent('MessageSent')`; falha final (job esgotou attempts) → `failed` + `failReason` + TimelineEvent — falha NUNCA silenciosa.
- Estados via `updateMany` com filtro de estado atual (transição atômica: `updateMany({ where: { id, state: 'queued' }, data: { state: 'sending' } })` — count 0 = job duplicado, retorna).

- [ ] **Step 1: Teste que falha** — `send-flow.test.ts`: fixture própria de company/customer/conversation via testing; `vi.mock` do `provider-factory` para um provider fake que registra chamadas e devolve `{ providerMessageId: 'FAKE123' }`; POST /messages com auth mockada (padrão do happy-path test) → 202; rodar o processador do job diretamente → Message termina `sent` com providerMessageId `FAKE123` e Timeline registrada; segunda execução do mesmo job é no-op (transição atômica); provider fake que lança → após a última tentativa Message `failed` com `failReason`.

- [ ] **Step 2: RED → implementar → GREEN.** Gate completo.

- [ ] **Step 3: Envio REAL de fumaça** — script curto: cria/acha a conversation do número do piloto na company `Aios Pocket` e envia "resposta de teste do Aios Pocket" pela rota (token real do Supabase via login programático OU chamada direta do use case com runWithTenant — registrar qual). Confirmar com o usuário que chegou no celular.

- [ ] **Step 4: Commit** — `git commit -m "feat(api): envio de mensagem — rota 202 + worker com maquina de estados (ADR-0006)"`

---

### Task 12: Deploy da API no EasyPanel + E2E do critério (CHECKPOINT final)

**Files:**
- Create: `apps/api/Dockerfile`, `.github/workflows/deploy-api.yml`, `.dockerignore`
- Modify: `docs/superpowers/2026-08-08-plano-a-carryover.md` (baixas dos itens resolvidos)

**Interfaces:**
- Produces: imagem `ghcr.io/0xdisruptivo710/crm-api:latest` buildada no GitHub Actions (NUNCA no droplet); serviço `api` no projeto `aios-pocket` do EasyPanel puxando a imagem; webhook da instância dev apontando para a URL pública estável; critério ponta-a-ponta provado.

- [ ] **Step 1: Dockerfile multi-stage**

`apps/api/Dockerfile` (build no CI, contexto = raiz do monorepo):
```dockerfile
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
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
# tsx em produção é decisão consciente desta fase (sem build step); revisitar se pesar.
CMD ["pnpm", "--filter", "@aios-pocket/api", "exec", "tsx", "src/server.ts"]
```
`.dockerignore`: `node_modules`, `.git`, `.env*`, `docs`, `.superpowers`, `.turbo`.

- [ ] **Step 2: Workflow de build/push**

`.github/workflows/deploy-api.yml`: on push to master (paths: apps/**, packages/**, Dockerfile); jobs: docker/login-action no GHCR com `GITHUB_TOKEN` (permissions packages: write), docker/build-push-action com tags `ghcr.io/0xdisruptivo710/crm-api:latest` e `:${{ github.sha }}`. Commit e push; conferir a imagem publicada.

- [ ] **Step 3: Serviço no EasyPanel (usuário cola o schema — checkpoint)**

Schema do serviço `api` no projeto `aios-pocket`: `type: app`, `source: { type: 'image', image: 'ghcr.io/0xdisruptivo710/crm-api:latest' }` (se o pacote GHCR for privado, instruir o usuário a torná-lo público OU configurar registry credentials no EasyPanel), env com: `DATABASE_URL` (host INTERNO `aios-pocket_postgres-dev:5432`), `REDIS_URL` (interno `aios-pocket_redis-dev:6379`), `SUPABASE_URL`, `APP_ENCRYPTION_KEY`, `EVOLUTION_DEV_*`, `PORT=3001`; domain `aios-pocket-api.yspmhc.easypanel.host` → porta 3001; aba Recursos → limite 768 MB.
Verificar: `curl https://aios-pocket-api.yspmhc.easypanel.host/health` → `{"status":"ok"}`.

- [ ] **Step 4: Webhook definitivo + E2E do critério (com o usuário)**

Repontar o webhook da instância DEV para `https://aios-pocket-api.yspmhc.easypanel.host/webhooks/evolution/<webhookToken>` (mesmo curl da Task 7). Roteiro final com o usuário:
1. Ele manda um WhatsApp real para o número do piloto → conferir Message inbound + Customer + Timeline no banco (query).
2. Resposta enviada pela API → chega no celular dele (Task 11 Step 3 repetido em produção).
3. Ele responde DO CELULAR do piloto → vira outbound (`fromMe`) no banco.
Registrar as evidências (ids, timestamps) em `docs/superpowers/notes/` e dar baixa no carry-over dos itens resolvidos pelo Plano B.

- [ ] **Step 5: Gate completo + commit + PR pronto** — `git commit -m "feat: deploy da API no EasyPanel via imagem GHCR + criterio E2E Evolution provado"`. Marcar o PR como ready for review.

---

## Critério de pronto do Plano B

1. Mensagem real de WhatsApp → `raw_webhook_events` → Customer (E.164) + Conversation + Message + TimelineEvent no banco, com dedupe e idempotência provados por teste.
2. Resposta enviada pela API chega no celular do piloto; `fromMe` do celular vira outbound; acks movem a máquina de estados.
3. Suíte de contrato de provider verde sobre >= 15 fixtures reais sanitizadas cobrindo texto, fromMe, áudio, imagem, documento, reply, edição, acks e conexão.
4. API deployada no EasyPanel via imagem do GHCR (zero build no droplet), `/health` público respondendo, webhook estável.
5. Carry-over do Plano A: todos os itens "Plano B" resolvidos ou re-triados com justificativa.
6. Gate completo + CI verde no PR.

**Produção intocada:** instância `murilo`, webhook do n8n e projeto `aios` seguem exatamente como estavam — conferir no fim (`GET /webhook/find/murilo` idêntico ao sondado em 2026-08-08).



