# Plano A — Carry-over triado pela revisão final (2026-08-08)

Itens levantados nas revisões do Plano A e triados pela revisão final da branch. Cada plano seguinte DEVE consumir sua lista ao ser escrito.

## Plano B (pipeline Evolution) — obrigatórios

Todos os itens abaixo foram consumidos pelo Plano B (Tasks 1-12) e fechados pela wave final de fix (2026-08-10). Status e como:

- **[RESOLVIDO]** Listeners de `error` nas duas conexões IORedis — `apps/api/src/queue/connection.ts` chama `.on('error', ...)` em `redisWorkerConnection` e `redisQueueConnection`.
- **[RESOLVIDO]** Pool Prisma único — `packages/db/src/client.ts` exporta `export const prisma = createTenantClient(prismaUnsafe)`; não existe mais `new PrismaClient()` duplicado.
- **[RESOLVIDO]** CI detecta drift de migração — `.github/workflows/ci.yml` roda `prisma migrate diff --from-migrations ... --to-schema-datamodel ... --exit-code` logo após o `db:deploy`.
- **[RESOLVIDO]** Validação de tamanho da chave de cifra — `packages/db/src/crypto.ts` (`encryptJson`/`decryptJson`) lança erro claro para chave != 32 bytes; caso coberto em `crypto.test.ts`.
- **[RESOLVIDO]** Timeout explícito no JWKS — `apps/api/src/auth/verify.ts`: `createRemoteJWKSet(url, { timeoutDuration: 5000 })`.
- **[RESOLVIDO]** Zod sem API deprecated — `packages/contracts/src/events.ts` usa `z.uuid()` nos dois campos (`companyId`, `correlationId`).
- **[RESOLVIDO]** DLQ/retry/backoff da fila — `apps/api/src/queue/queues.ts` define `WEBHOOK_JOB_RETRY_OPTIONS`/`MESSAGE_SEND_JOB_RETRY_OPTIONS` (`attempts: 3`, backoff exponencial, `removeOnComplete` com TTL de 7 dias), exercitados em `events.test.ts`/`send-flow.test.ts`.
- **[RESOLVIDO]** Testes negativos de contracts via fixtures reais — `packages/providers/test/contract-suite.ts` asserta por `kind` (`media` não-nulo em áudio/imagem/documento, `replyToProviderMessageId` em reply, `isEdit` em edição) sobre as fixtures reais sanitizadas.
- **[RESOLVIDO]** Repositório de company pré-tenant sancionado — `packages/db/src/repositories/companies.ts` (`companiesRepo.findByWebhookToken`/`findById`), testado em `companies-repo.test.ts`.
- **[RESOLVIDO]** `enterTenant` removido — apagado de `packages/db/src/tenant-context.ts` e do export de `index.ts`; grep confirma zero callers restantes (só uma menção histórica em comentário de `app.ts` explicando o bug original).
- **[RESOLVIDO, aceito com justificativa]** Turbo cacheia `test` contra estado externo (DB/Redis remotos) — mantido o cache padrão (sem `"cache": false"`): todas as vars que os testes consomem (`DATABASE_URL`, `REDIS_URL`, `EVOLUTION_DEV_*` etc.) já entram em `tasks.test.env` do `turbo.json`, então qualquer mudança de ambiente já invalida o cache; combinado com o fato de ser hoje um único developer/ambiente (sem CI concorrente disputando o mesmo banco/Redis), o risco de um PASS cacheado enganoso foi aceito. Reavaliar se a equipe/CI crescer.
- **[RESOLVIDO, decisão registrada]** Build de produção da API — `apps/api/Dockerfile` mantém `tsx` em runtime (comentário explícito: "decisão consciente desta fase, sem build step"); revisitar se o custo de runtime pesar.
- **[RESOLVIDO]** Cobertura de handler-com-await-antes-de-getTenant — as Tasks 9-11 introduziram handlers reais com awaits internos sob `runWithTenant` (pipeline inbound, envio de mensagem), cobertos em `pipeline-inbound.test.ts`/`send-flow.test.ts`; o teste de `/me` permanece como prova do fix original do ALS (handler em si segue sem await interno, por ser trivial).
- **[RE-TRIADO, risco aceito]** `.catch` terminal no hook de auth (`apps/api/src/app.ts`) segue sem `try/catch` interno — o Plano B não tocou o hook de autenticação (rotas de webhook são públicas, sem JWT) e o cenário de exceção dentro do `.catch` (ex.: falha de serialização do log) continua efetivamente inalcançável hoje. Endurecer quando o hook crescer.

## Plano C (inbox realtime)

- Teste ponta-a-ponta com JWT real do Supabase (caminho JWKS de assinatura — único gap de auth aceito).
- Verificar antes: projeto Supabase usa chaves assimétricas de assinatura JWT (se for HS256 legado, todo token real dá 401 — `verify.ts` assume JWKS).
- Pendências de credencial: `SUPABASE_DATABASE_URL` (senha do banco) para migrar o Supabase real; Vercel CLI/projeto.

**Plano C intake (achados da revisão final do Plano B, 2026-08-10):**

- Consumer de `ConnectionChanged` — hoje só é publicado (Task 10); ninguém reage. Inbox realtime precisa alertar quando a instância cair (Domain.md: "instância morta em silêncio é o pior modo de falha").
- Id estável de mensagem no contract da API (`POST /messages`) — corrige o "echo-row"/"202 dangling" (a rota responde 202 antes do `providerMessageId` existir; o eco da Evolution pode chegar e criar uma linha canônica separada antes do worker terminar).
- `worker.on('error')` nos Workers BullMQ (`webhook-processing`, `message-send`, `domain-events`) — hoje só as conexões IORedis têm listener de erro; o próprio `Worker` também emite `'error'` (distinto de `'failed'`) e não tem handler.
- `excludeInFlight` (`apps/api/src/queue/send-worker.ts`) sem paginação/limite — `messageSendQueue.getJobs(['active','waiting','delayed'])` varre a fila inteira; avaliar bound quando o volume crescer.
- TOCTOU na unicidade parcial além do caso já coberto — `resolveCustomer`/`companiesRepo` tratam a corrida de criação concorrente via P2002 + re-read num ponto; mapear os demais pontos de criação concorrente do pipeline (Conversation, Message) com o mesmo padrão.
- `sendMedia` — primeira execução REAL ainda pendente contra a Evolution de verdade (endpoint e `fileName` do envio de áudio não confirmados em produção; só `sendText` foi provado ponta-a-ponta).
- Naming de `MessageReceived` para eventos `fromMe` — o nome sugere "recebido do cliente", mas hoje também é publicado quando o humano responde pelo próprio celular (fromMe); revisar nomenclatura do evento de domínio antes do Plano C consumir.

## Plano D (docs/ADRs) — EXECUTADO 2026-08-28/29 (branch plano-d-docs-adrs)

- **[RESOLVIDO]** ADR-0001: limites compostos da tenancy documentados — `docs/adr/0001-application-tenancy.md` + `docs/Database.md` §tenancy.
- **[RESOLVIDO]** Exceção de convenção dos enums PascalCase registrada — `docs/Database.md` §convenções.
- **[RESOLVIDO]** Polimentos de type (T10): `Resolved<T>` no `runWithTenant`, guard `PromiseLike` no `isThenable`, `TenantSafe` (Omit espelhando EXATAMENTE os bloqueios de runtime, com isenção de `rawWebhookEvent`) no tipo do client; testes de guard de runtime preservados via `@ts-expect-error`.

**PIVÔ 2026-08-23 (ADR-0008/0009/0010, docs/adr/): a Z-API saiu do roadmap — o segundo provider é a UAZAPI, junto com a entidade Channel no núcleo; Zernio (API oficial) vira Fatia 9. Todo item abaixo que citava Z-API foi re-alvo para UAZAPI.**

**Plano D intake (achados da revisão final do Plano B, 2026-08-10; re-alvo em 2026-08-23):**

- **[RESOLVIDO no Plano D, T9]** Vocabulário da `contract-suite` — a suíte já era provider-agnóstica por assinatura (`runProviderContractSuite(provider, fixturesDir)`); só o comentário citava Z-API, re-alvo para UAZAPI com os itens a cobrir na Fatia 4 anotados nele.
- `zapi` short-circuit em `provider-factory.ts` (`throw new Error('ZApiProvider: Plano D')`) — substituir pelo `UazapiProvider` real quando ele existir; junto, migração do enum `provider` no Prisma (`zapi` → `uazapi`, nenhuma linha usa o valor antigo) — ADR-0008.
- **[RESOLVIDO no Plano D, T11]** `failReason` formalizado no `messageViewSchema` (nullable), atravessando GET /conversations/:id/messages, com tooltip do motivo real na cicatriz ✗ do inbox.
- Verificar se a UAZAPI emite evento de edição de mensagem — achado da Task 7/8: a Evolution 2.3.7 NÃO emite (2 tentativas controladas); condição de partida possivelmente diferente para a suíte de contrato.
- UAZAPI marca `wasSentByApi` no webhook do próprio envio — sinal explícito a mais para a guarda de eco do pipeline (hoje calibrada só para a Evolution); cobrir na suíte de contrato (ADR-0008).
- Entidade `Channel` (ADR-0009) entra na Fatia 4 junto com o segundo provider: migração + backfill (Conversation existente → canal Evolution default por Company); config de provider por tenant migra para a linha do canal; roteamento de webhook resolve canal, não "o provider do tenant"; `ConnectionStatusChange` passa a referenciar canal.
- Referência de estrutura da UAZAPI (endpoints, shape de webhook, anti-loop): código do Mega CRM local (`_shared/uazapi.ts`, `uazapi-webhook/index.ts`) — referência, NUNCA fixture; fixtures capturadas ao vivo da nossa instância.

## Runbook de deploy (pós-merge)

- Mudança de schema pós-merge: rodar manualmente `DATABASE_URL=<live> prisma migrate deploy` ANTES do redeploy do EasyPanel (a imagem não migra sozinha).

## Pós-merge (aprendizados do primeiro CI real — já corrigidos na master)

- `@types/node` precisa ser devDependency explícita onde builtins de node são usados — hoisting local mascarava (quebrou no Linux limpo do CI).
- Turbo em modo estrito filtra env vars não declaradas: toda task que consome env do job de CI precisa da lista em `tasks.<task>.env` no turbo.json (bônus: env entra na chave de cache).
- Lição de verificação: simular CI pelo arquivo `.env` NÃO é fiel — o mecanismo de entrega (arquivo vs ambiente do processo) muda o comportamento do turbo. Simulação fiel = `.env` vazio + vars por processo.
- Aviso do Actions: checkout@v4/setup-node@v4/pnpm-action@v4 têm target Node 20 deprecado (rodam forçadas em Node 24) — bump para as majors novas no Plano B.

## Regra de processo adotada (vale para todos os planos)

Toda costura entre tasks (auth→tenant, rota→fila, webhook→pipeline) ganha pelo menos **um teste happy-path mockado no mesmo plano** — o Critical do Plano A (contexto ALS não propagava; só branches de erro testados) ficou invisível a todas as revisões por task exatamente por falta disso.

## Segurança operacional (registro)

- Produção do usuário (projeto `aios` no EasyPanel: Evolution + n8n) roda no MESMO droplet da infra de dev — intocável; nunca buildar imagens no droplet (CI builda, EasyPanel puxa).
- Rotacionar credenciais da stack `dinastia` que circularam em conversa (Postgres, Redis, chave n8n, API key Evolution).
- Testes que fazem wipe têm `assertSafeToWipe` (recusa hosts supabase.co e db fora de aios-pocket/aios_pocket); wipe do tenancy.test destrói o seed do piloto a cada run — re-rodar `db:seed` quando necessário.

## Intake pós-E2E da Fatia 1 (T10, 2026-08-28) — para os Planos D+

- **Latência realtime insert→tela ~1,5–2,2s em produção** (debounce 300ms + refetch completo): otimizar com fast-path — mapear o payload do INSERT direto para a conversa aberta (dedupe por id já existe) e manter o refetch como reconciliação; reavaliar o debounce.
- **Watchdog de morte silenciosa da instância**: `Company.connectionState` só muda por webhook — Evolution com processo morto congela em `connected` e o banner nunca acende ("instância morta em silêncio é o pior modo de falha", Domain.md). Falta healthcheck ativo (poll de `/instance/connectionState` pela API ou cron) que marque `disconnected` na ausência de resposta.
- **Rotação de credenciais (bloco 2026-08-28)**: env completa do serviço `api` circulou em conversa (DATABASE_URL/Supabase, REDIS_URL dev, APP_ENCRYPTION_KEY, EVOLUTION_DEV_API_KEY). Rotacionar após o merge; APP_ENCRYPTION_KEY exige re-cifrar `providerCredentials` das Companies (escrever script). Também pendentes: senhas em claro no histórico WhatsApp do piloto (11/08) e stack `dinastia`.
- Nota operacional: `POST /instance/restart` da Evolution NÃO derruba a sessão (sem `connection.update`); teste real do banner = logout pelo celular + QR novo. Manager UI trava com deep link `instance/undefined` — entrar pela raiz `/manager`.
