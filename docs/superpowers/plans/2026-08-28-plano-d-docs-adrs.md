# Plano D — Documentação definitiva: docs/, ADRs 0001–0007 e CLAUDE.md enxuto

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materializar a documentação prevista na Primeira Missão do CLAUDE.md semente (itens 2–3) e no seu ciclo de vida (seção 8): `docs/` completo, ADRs 0001–0007, CLAUDE.md enxugado para a forma definitiva — mais os polimentos de código triados no carry-over para o Plano D.

**Architecture:** Documentos densos e curtos gerados a partir da seção 3 do CLAUDE.md semente + ADRs 0008–0010 + notas de evidência dos Planos A–C + carry-over. Nenhuma decisão NOVA nasce aqui — o plano só registra o que já foi decidido e provado. Os 3 últimos tasks são código pequeno (renomes/typing/contrato) com gate completo.

**Tech Stack:** Markdown (docs/adr), TypeScript/Zod (polimentos), turbo (gate).

**Spec:** o CLAUDE.md semente (raiz do repo, seções 3, 6, 7 item 2–3 e 8) + `docs/superpowers/2026-08-08-plano-a-carryover.md` (seções "Plano D" e "Intake pós-E2E") + `docs/adr/0008..0010`.

## Global Constraints

- Idioma: docs e comentários em português; identificadores em inglês (CLAUDE.md §4).
- `docs/` total ≤ ~30 páginas; cada ADR = 1 página (problema → decisão → consequências).
- ADRs 0001–0007 DEVEM nascer coerentes com as 0008–0010 já existentes (nunca contradizê-las).
- CLAUDE.md final: 150–250 linhas; arquitetura mora em docs/, decisão em ADR, regra mecanizável no lint/CI — o arquivo guarda só o que a IA precisa lembrar e nenhuma ferramenta verifica.
- Nada de decisão nova: qualquer coisa não coberta por decisão existente vira item de carry-over, não texto normativo.
- Tasks de código: gate = `pnpm typecheck && pnpm lint && pnpm test` verdes antes do commit.
- Commits frequentes, um por task, mensagem em português, convenção `docs:`/`refactor:`/`feat:` como no histórico.

---

### Task 1: `docs/Vision.md` + `docs/Roadmap.md`

**Files:**
- Create: `docs/Vision.md`, `docs/Roadmap.md`

**Interfaces:** Roadmap.md é a fonte citada pelo CLAUDE.md enxuto (Task 7). Vision.md abre a pasta docs/.

- [ ] **Step 1: Vision.md (~1,5 página)** — conteúdo: (a) o que é: Operating System para empresas que vendem/atendem pelo WhatsApp, CRM multi-tenant SaaS operado pela AIOS — não um conjunto de módulos; (b) núcleo de identidade como centro (Company, Channel, Customer, Conversation, Message, TimelineEvent) e os seis domínios que o referenciam sem duplicá-lo (Atendimento, Agenda, Kanban, Follow-up, Campanhas, Relatórios); (c) princípios de produto: fatias verticais com critério de pronto demonstrável em infra real; fixtures reais como patrimônio; "instância morta em silêncio é o pior modo de falha"; (d) estado atual: Fatia 1 completa e provada em produção (2026-08-28, aios-pocket.vercel.app), citar `docs/superpowers/notes/2026-08-28-e2e-fatia-1.md`.
- [ ] **Step 2: Roadmap.md (~2 páginas)** — tabela das fatias 0–10 EXATAMENTE como no CLAUDE.md semente pós-pivô (0 ✅, 1 ✅ com data e evidência, 2 Contatos, 3 Kanban, 4 Channel+UAZAPI ADR-0008/0009, 5 Agenda, 6 Follow-up+automações de funil, 7 Campanhas, 8 Relatórios+Meta Ads via Zernio, 9 Zernio API oficial+Instagram ADR-0010, 10 Agente IA+handoff) + regras: teto de fatias 0+1, nenhuma N+1 sem critério da N batido, blueprint Mega CRM para 3/6/7/8 (traduzir, nunca copiar arquitetura; payloads Zernio "ASSUMIDO" não são fixture; referência local fora do repo, nunca commitar).
- [ ] **Step 3: Commit** — `git add docs/Vision.md docs/Roadmap.md && git commit -m "docs: Vision e Roadmap (Plano D)"`

---

### Task 2: `docs/Architecture.md`

**Files:**
- Create: `docs/Architecture.md`

- [ ] **Step 1: escrever (~4 páginas)** — seções: (a) Stack inegociável e deploys (Next.js/Vercel; Fastify+BullMQ+Prisma em UM deployable no EasyPanel; Supabase Postgres/Auth/Realtime; Redis; pnpm+Turborepo; proibições: microsserviços, NestJS, WebSocket próprio v1, segundo deployable); (b) estrutura do monorepo (apps/web, apps/api, packages/contracts|db|providers, docs/, tests/providers/fixtures/{evolution,uazapi}); (c) fluxo inbound: webhook → arquivo raw → fila BullMQ → pipeline idempotente → núcleo + TimelineEvent → Realtime; fluxo outbound: rota 202 → fila → worker stall-safe → provider → acks via webhook; (d) comunicação entre módulos (síncrono dentro do domínio, evento entre domínios, pós-commit, consumers idempotentes, correlation_id em tudo); (e) realtime v1 (Supabase postgres_changes, RLS read-only só messages/conversations, evento=sinal→refetch — citar ADR-0005 e a nota T8); (f) deploy/CI (imagem GHCR via Actions, EasyPanel só puxa, NUNCA buildar no droplet; migração manual `prisma migrate deploy` antes do redeploy quando houver schema novo); (g) mapa de infra atual: Vercel (web), EasyPanel droplet 143.198.98.6 (api + evolution-dev + redis-dev + postgres-dev test), Supabase (banco vivo) — e a REGRA DURA da produção `aios` intocável no mesmo droplet.
- [ ] **Step 2: Commit** — `git commit -m "docs: Architecture (Plano D)"`

---

### Task 3: `docs/Domain.md`

**Files:**
- Create: `docs/Domain.md`

- [ ] **Step 1: escrever (~4 páginas)** — seções: (a) núcleo de identidade entidade a entidade (Company; Channel — ADR-0009, entra na Fatia 4, regra "1 conversa = 1 canal = 1 provider, nunca fallback"; Customer; Conversation; Message; TimelineEvent) e entidades de domínio (Appointment, Card, FollowupFlow/Execution, Campaign) com a proibição da Task genérica; (b) telefone: E.164 canônico, original preservado, regra do 9º dígito, Customer resolvido/criado na chegada de qualquer mensagem; (c) máquina de estados da mensagem (received | queued | sending | sent | delivered | read | failed) com transições e quem as dispara (rota, worker, acks), eco fromMe e guarda de eco, idempotência por clientMessageId; (d) Timeline = event log append-only (NÃO event sourcing — estado vive nas tabelas de domínio), payload com schema_version desde o evento nº 1, eventos atuais reais: message_received, message_sent_from_phone, transições de estado; (e) webhooks normalizados: os 3 tipos internos (IncomingMessage com fromMe/mídia/reply/edição, MessageStatusUpdate, ConnectionStatusChange) e idempotência por provider+providerMessageId+tipo; (f) limitação documentada do badge de conexão: reflete webhooks; morte silenciosa da Evolution não acende banner — watchdog é trabalho futuro (intake 2026-08-28).
- [ ] **Step 2: Commit** — `git commit -m "docs: Domain (Plano D)"`

---

### Task 4: `docs/Database.md`

**Files:**
- Create: `docs/Database.md`

- [ ] **Step 1: escrever (~3 páginas)** — seções: (a) tabelas atuais do schema Prisma (companies, users, customers, conversations, messages, customer_events, raw_webhook_events) com os uniques/índices que carregam regra de negócio (dedupe por provider+pmid, clientMessageId por company, índice de dedupe da timeline); (b) tenancy: company_id em toda tabela de negócio, enforcement pela client extension + TenantContext + repositories; limites compostos DOCUMENTADOS (carry-over ADR-0001): sem validação FK cross-tenant, nested writes/`connect` não interceptados, Company ilegível pelo client tenantizado por design (repositório pré-tenant sancionado); (c) exceção RLS: políticas read-only + publication só em messages/conversations para o Realtime, Data API fechada para anon/authenticated, policy via SECURITY DEFINER (citar migrations 20260816*); (d) convenções: exceção registrada — types de enum Postgres em PascalCase (renomear = migração sem ganho); migrations aditivas, nunca editar migration aplicada; (e) bancos: Supabase = vivo; droplet postgres-dev = test/CI + evolution; wipe guards (`assertSafeToWipe` recusa hosts supabase).
- [ ] **Step 2: Commit** — `git commit -m "docs: Database (Plano D)"`

---

### Task 5: `docs/Conventions.md`

**Files:**
- Create: `docs/Conventions.md`

- [ ] **Step 1: escrever (~3 páginas)** — seções: (a) código: TS strict, sem any, regra de negócio em use cases/services nunca em rotas, composição > herança, abstração só com 2+ usos reais, validação Zod em todo endpoint com schemas em packages/contracts, operação lenta → fila, português nos comentários/identificadores em inglês; (b) fixtures reais = patrimônio: tests/providers/fixtures/{evolution,uazapi}, todo bug de provider vira fixture, toda fixture vira teste, captura ao vivo (nunca payload inventado quando existir real), sanitização; (c) testes: TDD, toda costura entre tasks ganha teste happy-path mockado no mesmo plano (regra de processo adotada — Critical do Plano A), suite dos DOIS providers quando tocar webhook/provider, timeouts explícitos em testes de integração contra infra remota (lição 2026-08-23); (d) enforcement mecânico (o que o CI verifica): ESLint proíbe any/import Prisma fora de packages/db/hosts de provider fora de packages/providers; testes de arquitetura (company_id obrigatório, TenantContext); CI typecheck+lint+test+migrations em todo PR; (e) processo: fatia vertical → brainstorm → plano com tasks → execução com revisões → nota de evidência → carry-over triado → merge com CI verde; ADR antes de código para mudança estrutural; checkpoints para operação em lote/destrutiva; (f) runbook de deploy pós-merge (migração manual antes do redeploy; EasyPanel puxa imagem).
- [ ] **Step 2: Commit** — `git commit -m "docs: Conventions (Plano D)"`

---

### Task 6: ADRs 0001–0004

**Files:**
- Create: `docs/adr/0001-application-tenancy.md`, `docs/adr/0002-provider-pattern.md`, `docs/adr/0003-webhooks-normalizados.md`, `docs/adr/0004-timeline-event-log.md`

**Interfaces:** formato idêntico às 0008–0010 (header com Data/Status, seções Problema/Decisão/Consequências, 1 página). Data das decisões originais: 2026-08-07 (semente); Status: aceita (implementada nas Fatias 0–1).

- [ ] **Step 1: 0001 Application Tenancy** — problema: isolamento multi-tenant com um único Postgres; decisão: company_id em toda tabela de negócio + Prisma client extension com TenantContext + repositories; RLS NÃO é o mecanismo (exceção única: ADR-0005); service_role jamais no frontend; consequências: enforcement testável na aplicação; limites compostos aceitos e documentados (FK cross-tenant sem validação, nested writes não interceptados, Company pré-tenant via repositório sancionado — Database.md); testes de arquitetura no CI.
- [ ] **Step 2: 0002 Provider Pattern** — problema: múltiplas APIs de WhatsApp com semânticas diferentes; decisão: contrato único MessagingProvider em packages/providers, nenhum módulo de negócio conhece provider; implementações registradas por ADR (Evolution hoje; UAZAPI Fatia 4 — ADR-0008; Zernio Fatia 9 com extensão de contrato — ADR-0010; Z-API saiu sem código — ADR-0008); consequências: ESLint proíbe hosts fora do package; suíte de contrato compartilhada é o critério de aceitação de provider novo.
- [ ] **Step 3: 0003 Webhooks normalizados** — problema: payloads díspares e campos aprendidos em produção; decisão: endpoints por provider convertendo imediatamente para IncomingMessage/MessageStatusUpdate/ConnectionStatusChange; fromMe vira outbound; correlação de mídia; reply; edição substitui leitura; idempotência por provider+providerMessageId+tipo; todo raw arquivado e candidato a fixture; consequências: pipeline testável por fixtures; dedupe garante reprocessamento seguro.
- [ ] **Step 4: 0004 Timeline = event log (+ eventos entre domínios)** — problema: histórico/auditoria/analytics/contexto de IA sem acoplar domínios; decisão: customer_events append-only com schema_version e correlation_id; timeline é query; NÃO é event sourcing (estado nas tabelas de domínio); síncrono dentro do domínio, evento entre domínios, publicado pós-commit, consumers idempotentes; consequências: rastreabilidade ponta-a-ponta (provada no E2E: mesmo correlationId webhook→message→evento); nome `message_sent_from_phone` registrado (renomeado do ambíguo MessageReceived — carry-over B).
- [ ] **Step 5: Commit** — `git commit -m "docs: ADRs 0001-0004 (Plano D)"`

---

### Task 7: ADRs 0005–0007

**Files:**
- Create: `docs/adr/0005-realtime-supabase.md`, `docs/adr/0006-message-state-machine.md`, `docs/adr/0007-nucleo-e-dominio.md`

- [ ] **Step 1: 0005 Realtime via Supabase** — problema: inbox em tempo real sem servidor WebSocket próprio; decisão: postgres_changes em messages/conversations, RLS read-only + publication só nessas tabelas (exceção única da 0001), Data API fechada, policy SECURITY DEFINER; no cliente, evento=sinal→refetch dos DTOs (nunca mapear linha crua no front); WebSocket próprio só com motivo técnico real + nova ADR; consequências: provado na T8/T10; latência insert→tela ~1,5–2,2s em produção com fast-path registrado como evolução futura (carry-over).
- [ ] **Step 2: 0006 Máquina de estados da mensagem** — problema: rastrear entrega sem inbox/outbox separados; decisão: UMA tabela messages com estados received|queued|sending|sent|delivered|read|failed, transições registradas na Timeline, envio stall-safe com reconciliação e UnrecoverableError, idempotência por clientMessageId (unique por company); consequências: falha nunca silenciosa (failReason + cicatriz visível), acks alimentam a UI via realtime.
- [ ] **Step 3: 0007 Núcleo + domínio** — problema: módulos duplicando identidade; decisão: núcleo estável Company/Channel(ADR-0009)/Customer/Conversation/Message/TimelineEvent; entidades de domínio referenciam o núcleo (Appointment, Card, FollowupFlow/Execution, Campaign); PROIBIDA Task genérica — visão unificada de pendências, se um dia existir, é projeção de leitura sobre a Timeline; consequências: cada fatia nova referencia, nunca duplica; blueprint Mega CRM traduzido para este núcleo (Roadmap.md).
- [ ] **Step 4: Commit** — `git commit -m "docs: ADRs 0005-0007 (Plano D)"`

---

### Task 8: CLAUDE.md definitivo (150–250 linhas) + sync da cópia externa

**Files:**
- Modify: `CLAUDE.md` (reescrita completa)
- Modify (fora do repo): `C:\Users\Usuario\Desktop\CRM\CLAUDE.md` (cópia sincronizada)

**Interfaces:** consome docs/ e adr/ das Tasks 1–7 (aponta para eles, não os repete).

- [ ] **Step 1: reescrever o CLAUDE.md** com esta estrutura (alvo 150–250 linhas): (1) parágrafo de identidade do produto (3 linhas) + papel do agente (Arquiteto Principal: preservar consistência, não gerar código livremente); (2) mapa de ponteiros: arquitetura → docs/Architecture.md; domínio → docs/Domain.md; banco → docs/Database.md; convenções/processo → docs/Conventions.md; roadmap → docs/Roadmap.md; decisões → docs/adr/ (0001–0010, uma linha por ADR); evidências → docs/superpowers/notes/; carry-over → docs/superpowers/2026-08-08-plano-a-carryover.md; (3) seção 4 do semente na ÍNTEGRA (regras de operação não mecanizáveis — memorize); (4) seção 5 como referência resumida (o que o CI verifica, uma linha por item); (5) regras duras operacionais: produção `aios` no mesmo droplet intocável, nunca buildar no droplet, migração manual antes de redeploy com schema novo, checkpoints para operações em lote/destrutivas, credenciais nunca em arquivos commitados/memória/chat; (6) "ADR antes de código" para qualquer mudança estrutural. REMOVER: seções 1–3 (viraram docs/adr), 6 (Roadmap.md), 7 (missão cumprida) e 8 (ciclo encerrado).
- [ ] **Step 2: verificar** — `wc -l CLAUDE.md` entre 150 e 250; grep confirma que TODAS as regras da seção 4 original sobreviveram; nenhuma referência a Z-API como provider ativo.
- [ ] **Step 3: sincronizar cópia externa** — `cp CLAUDE.md ../CLAUDE.md`
- [ ] **Step 4: Commit** — `git commit -m "docs: CLAUDE.md definitivo — semente enxugada, arquitetura mora em docs/ e ADRs (seção 8 do semente)"`

---

### Task 9: Polimento — vocabulário neutro da contract-suite (prep Fatia 4)

**Files:**
- Modify: `packages/providers/test/contract-suite.ts` (renomes/comentários apenas — zero mudança de comportamento)

- [ ] **Step 1:** renomear identificadores/comentários que citam Evolution como se fossem o contrato (ex.: nomes de helpers/describe genéricos "provider under test"; Evolution vira parâmetro/instância concreta). NENHUMA asserção muda.
- [ ] **Step 2:** `pnpm test --filter @aios-pocket/providers` — mesma contagem de testes passando de antes (comparar com a execução anterior ao rename).
- [ ] **Step 3: Commit** — `git commit -m "refactor(providers): contract-suite com vocabulário neutro de provider (prep Fatia 4, carry-over)"`

---

### Task 10: Polimentos de type (carry-over Plano A/D)

**Files:**
- Modify: `packages/db/src/tenant-context.ts` (tipagem `Resolved<T>` no runWithTenant; typing do `isThenable`), `packages/db/src/client.ts` (Omit das operações proibidas no tipo do client tenantizado)

- [ ] **Step 1:** aplicar os três polimentos deferidos: (a) `runWithTenant` retorna `Promise<Awaited<T>>`/equivalente em vez de union frouxa; (b) `isThenable` com type guard `value is PromiseLike<unknown>`; (c) tipo do client tenantizado com `Omit` das operações que a extension bloqueia em runtime ($transaction cru etc. — conforme o que a extension de fato bloqueia hoje; NÃO bloquear nada novo).
- [ ] **Step 2:** `pnpm typecheck && pnpm test --filter @aios-pocket/db` verdes; se algum call-site quebrar por tipagem mais estrita, ajustar o call-site (nunca afrouxar o tipo).
- [ ] **Step 3: Commit** — `git commit -m "refactor(db): polimentos de type do carry-over — Resolved no runWithTenant, type guard isThenable, Omit no client tenantizado"`

---

### Task 11: failReason no contrato de leitura + tooltip na UI

**Files:**
- Modify: `packages/contracts/src/api.ts` (messageViewSchema ganha `failReason: z.string().nullable()`), `apps/api/src/routes/conversations.ts` (select/map da rota de mensagens inclui failReason), `apps/web/app/inbox/conversation-view.tsx` (MessageStateIcon: `title={message.failReason ?? 'Falha no envio'}` no caso failed)
- Test: `packages/contracts/test/api.test.ts` (caso novo), `apps/api/test/read-endpoints.test.ts` (asserta failReason presente/null)

- [ ] **Step 1:** teste primeiro — em `api.test.ts`, caso validando messageView com `failReason: 'provider indisponível'` e com `null`; em `read-endpoints.test.ts`, fixture de mensagem failed asserta o campo na resposta. Rodar: FALHAM (campo inexistente).
- [ ] **Step 2:** implementar contrato + rota + tooltip. Rodar os dois arquivos de teste: PASSAM.
- [ ] **Step 3:** gate completo `pnpm typecheck && pnpm lint && pnpm test` + `pnpm turbo run build --filter=web`.
- [ ] **Step 4: Commit** — `git commit -m "feat: failReason no contrato de leitura e tooltip de falha no inbox (carry-over Plano D)"`

---

### Task 12: Revisão final, baixas no carry-over e memória

**Files:**
- Modify: `docs/superpowers/2026-08-08-plano-a-carryover.md`

- [ ] **Step 1: revisão cruzada dos docs** — checklist: cada item da seção 3 do semente original tem lar em docs/ ou ADR; nenhuma contradição com ADR-0008/0009/0010; links internos válidos; total de docs/ ≤ ~30 páginas.
- [ ] **Step 2: baixas no carry-over** — marcar [RESOLVIDO] com referência: itens "Plano D" (ADR-0001 limites → Database.md/ADR-0001; enum PascalCase → Database.md; polimentos de type → Task 10; vocabulário contract-suite → Task 9; failReason → Task 11). Itens que permanecem (UAZAPI edição/wasSentByApi/enum zapi→uazapi/Channel = Fatia 4; fast-path realtime; watchdog; rotação de credenciais) ficam listados sob "Fatia 4 / operacional".
- [ ] **Step 3:** gate completo + `git commit -m "docs: revisão final do Plano D — baixas no carry-over"`.
- [ ] **Step 4:** atualizar a memória do projeto (fora do repo): Plano D completo, CLAUDE.md definitivo, próximas: rotação pendente + Fatia 2.

---

## Critério de pronto do Plano D

1. `docs/` com os 6 documentos + `docs/adr/` com 0001–0010 — nenhuma decisão nova, tudo rastreável ao que já foi decidido/provado.
2. CLAUDE.md com 150–250 linhas apontando para docs/ADRs, com a seção 4 original preservada na íntegra e a cópia `Desktop\CRM\CLAUDE.md` sincronizada.
3. Polimentos (Tasks 9–11) com gate completo verde.
4. Carry-over com baixas dadas e restante re-triado para Fatia 4/operacional.
5. Trabalho na branch `plano-d-docs-adrs` (convenção da casa; evita disparar o build da imagem da API a cada commit de doc), merge fast-forward na master ao final com CI verde.
