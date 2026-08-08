# Aios Pocket — Design da Fatia 0 (+ critério da Fatia 1, com Z-API antecipada)

**Data:** 2026-08-08
**Status:** Aprovado no brainstorm; aguardando revisão final do usuário
**Fonte de autoridade:** `CLAUDE.md` (Prompt Orquestrador v1.0). Este spec não rediscute as decisões da seção 3 do semente — apenas as aplica à primeira entrega.

## 1. Contexto e objetivo

Aios Pocket é um Operating System para empresas que vendem e atendem pelo WhatsApp — CRM multi-tenant, SaaS, operado pela AIOS. Esta entrega constrói a fundação (Fatia 0) e a prova ponta-a-ponta (critério da Fatia 1), com uma alteração de roadmap decidida no brainstorm: **os dois providers (Evolution API e Z-API) entram já nesta entrega**, antecipando a Fatia 4.

### Decisões validadas no brainstorm

| Item | Decisão |
|---|---|
| Nome do produto | **Aios Pocket** — repo `aios-pocket`, packages `@aios-pocket/*` |
| Cliente piloto | O próprio usuário, conectando via QR code nas duas instâncias |
| Providers | Evolution **e** Z-API nesta entrega; Evolution implementado primeiro, Z-API em seguida contra a mesma suíte de contrato |
| Credenciais em mãos | Supabase, Evolution API, Z-API. O usuário fornece as chaves; o agente faz chamadas reais para capturar payloads |
| Redis | Local via Docker durante o desenvolvimento; Redis do EasyPanel na hora do deploy (acessos do EasyPanel: pendência de infra, não bloqueia a fatia) |
| Localização do repo | `C:\Users\Usuario\Desktop\CRM\aios-pocket` (git novo); o `CLAUDE.md` semente é copiado para a raiz do repo; repos de referência ficam fora |
| Fixtures | Sem payloads pré-capturados; captura ao vivo com as chaves reais desde o início |

## 2. Escopo

### Entra

- Monorepo pnpm workspaces + Turborepo, TypeScript `strict` em todos os packages.
- CI (GitHub Actions) com o enforcement mecânico completo (seção 8 deste spec).
- Auth mínima: Supabase Auth (email+senha); seed cria a company do piloto e seu usuário.
- TenantContext + Prisma client extension + repositories.
- Núcleo de dados: `companies`, `users`, `customers`, `conversations`, `messages`, `customer_events`, `raw_webhook_events`.
- Camada de providers: contrato `MessagingProvider`, `EvolutionProvider`, `ZApiProvider`, normalização para os 3 tipos internos.
- Webhooks `/webhooks/evolution` e `/webhooks/zapi` com arquivamento de payload cru e processamento assíncrono.
- Fila BullMQ (API + workers no mesmo processo) e eventos entre domínios com idempotência e `correlation_id`.
- Inbox mínimo realtime (Supabase Realtime) com envio de resposta.
- 6 docs + 7 ADRs enxutos; `CLAUDE.md` enxugado ao final.

### Não entra (fatias seguintes)

Kanban, Agenda, Follow-up, Campanhas, Relatórios, signup/onboarding, gestão de múltiplas companies pela UI, WebSocket próprio, disparos em massa, exibição de QR code no produto (a conexão da instância é feita no painel do próprio provider nesta entrega; nossa UI só mostra o status) e download de mídia para o Supabase Storage (nesta entrega armazenamos a referência/URL de mídia vinda do provider).

### Critério de pronto

1. Usuário manda WhatsApp para a instância → mensagem aparece no inbox em tempo real → responde pela UI → resposta chega no celular → Timeline registra tudo (nas **duas** instâncias: Evolution e Z-API, uma por vez — o teste da segunda troca o `active_provider` na config da company piloto; não se cria segundo tenant).
2. Enforcement mecânico rodando verde no CI.
3. Mesma suíte de contrato de providers passa na Evolution e na Z-API.

## 3. Estrutura do monorepo

```
aios-pocket/
├── apps/web            → Next.js App Router + TS + Tailwind + shadcn/ui (deploy: Vercel)
├── apps/api            → Fastify + workers BullMQ, um único processo (deploy: EasyPanel)
├── packages/contracts  → schemas Zod compartilhados: tipos de API, eventos, webhooks normalizados
├── packages/db         → schema Prisma + client extension de tenancy + repositories
├── packages/providers  → EvolutionProvider, ZApiProvider, camada de normalização
├── docs/               → Vision, Architecture, Domain, Database, Conventions, Roadmap
├── docs/adr/           → 0001–0007, uma página cada
├── docs/superpowers/specs/ → este spec e os próximos
└── tests/providers/fixtures/{evolution,zapi}/ → payloads reais sanitizados
```

Proibido: microsserviços, NestJS, WebSocket próprio, segundo deployable de backend.

## 4. Núcleo de dados

Toda tabela de negócio tem `company_id` (enforcement por teste de arquitetura; whitelist explícita para as tabelas globais, inicialmente vazia). Nomes de identificadores em inglês; comentários e docs em português.

- **companies** — tenant. Carrega o provider ativo (`active_provider: evolution | zapi`) e as credenciais da instância (cifradas na aplicação antes de persistir). Exatamente um provider ativo por company; sem fallback automático.
- **users** — operadores; `auth_user_id` vincula ao Supabase Auth.
- **customers** — identidade canônica do cliente final: `phone_e164` (canônico) + `phone_original` (como veio do provider). Matching aplica a regra do 9º dígito brasileiro (mesmo cliente com e sem o 9). Customer é resolvido/criado na chegada de qualquer mensagem.
- **conversations** — 1 customer ↔ N conversations; `external_id` do provider; status aberta/fechada.
- **messages** — tabela única (sem inbox/outbox separados). Estados: `received | queued | sending | sent | delivered | read | failed`. Campos: `from_me` (resposta enviada do celular entra como outbound), `provider_message_id`, referência de reply/quote, correlação de mídia, marcação de edição (versão editada substitui a exibida, original preservada). Dedupe por unique `(provider, provider_message_id, event_type)`.
- **customer_events** — Timeline append-only: `company_id`, `customer_id`, `type`, `payload` (com `schema_version` desde o evento nº 1), `occurred_at`, `correlation_id`. É log, **não** event sourcing: o estado vive nas tabelas de domínio.
- **raw_webhook_events** — arquivo de todo payload cru: `provider`, `company_id`, `received_at`, `payload` (JSONB), `processed`, `error`. Fonte das fixtures.

## 5. Camada de providers

### Contrato `MessagingProvider` (mínimo para esta entrega)

- `sendText(to, text, opts)` / `sendMedia(to, media, opts)`
- `parseWebhook(rawPayload)` → `IncomingMessage | MessageStatusUpdate | ConnectionStatusChange`
- `getConnectionStatus()`

Nenhum código fora de `packages/providers` conhece hosts ou formatos da Evolution/Z-API (bloqueado por ESLint). Tipos normalizados vivem em `packages/contracts`.

### Tipos normalizados (ADR-0003)

- **IncomingMessage** — provider, providerMessageId, phone, conversationExternalId, tipo, text, media, timestamp, metadata, `fromMe`, chave de correlação de mídia, referência de reply/quote, flag de edição.
- **MessageStatusUpdate** — acks de delivered/read; alimenta a máquina de estados.
- **ConnectionStatusChange** — instância caiu/QR desconectou → alerta imediato.

## 6. Fluxos

### Entrada (WhatsApp → inbox)

1. `POST /webhooks/{evolution|zapi}` identifica a company (token/ID de instância na URL ou header), **arquiva o payload cru em `raw_webhook_events` antes de qualquer parse** e responde 200 imediatamente.
2. Job BullMQ processa: dedupe → `parseWebhook` → resolve/cria Customer (E.164 + 9º dígito) → resolve/cria Conversation → insere Message (`received`; ou outbound se `fromMe`) → registra TimelineEvent.
3. `MessageStatusUpdate` move a máquina de estados; cada transição vira TimelineEvent.
4. `ConnectionStatusChange` gera evento + badge de status da instância na UI (nesta entrega o alerta é badge + TimelineEvent; push/email ficam para fatia futura). Instância morta nunca falha em silêncio.

### Saída (UI → celular)

1. UI chama rota Fastify (validação Zod de `packages/contracts`) → cria Message em `queued` → enfileira → retorna imediatamente. Rota HTTP nunca espera provider.
2. Worker de envio resolve o provider ativo do tenant → `sending` → `sent` (guarda `provider_message_id` para correlacionar acks) ou `failed` após retries com backoff exponencial. Falha final fica visível na conversa.

### Eventos e erros

- Eventos entre domínios publicados **após o commit**; consumers idempotentes; `correlation_id` em tudo. Dentro do domínio, chamada direta.
- Payload cru nunca se perde: parse com falha marca o registro como não-processado + alerta; vira candidato a fixture.
- Jobs esgotados caem em fila de falhas (DLQ) para inspeção.

## 7. Auth, tenancy e realtime

- Supabase Auth email+senha. Seed: 1 company + 1 usuário (o piloto). Sem signup nesta entrega.
- API valida JWT do Supabase em toda rota → monta `TenantContext` → Prisma client extension injeta `company_id` em toda query → acesso a dados só via repositories.
- `service_role` key jamais no frontend.
- Frontend assina `messages` e `conversations` via Supabase Realtime; políticas RLS **read-only apenas nessas duas tabelas** (exceção única do ADR-0001/0005).
- UI mínima: lista de conversas, tela da conversa (bolhas com estado, indicador de `from_me`), campo de envio, badge de status da instância. Mensagens de mídia recebidas aparecem como anexo simples (tipo + link da referência do provider), sem player/preview. shadcn/ui. Nada além.

## 8. Enforcement mecânico (critério de pronto no CI)

- **ESLint:** proíbe `any`; proíbe import do Prisma client fora de `packages/db`; proíbe import/fetch de hosts Evolution/Z-API fora de `packages/providers`.
- **Testes de arquitetura:** falham se um model Prisma nascer sem `company_id` (fora da whitelist) ou se um repository ignorar o TenantContext.
- **GitHub Actions:** typecheck + lint + testes + validação de migrations em todo PR. PR não passa, não mergeia.
- TypeScript `strict: true` em todos os packages.

## 9. Estratégia de testes

- **Suíte de contrato de providers** (coração da estratégia): a mesma bateria roda contra `EvolutionProvider` e `ZApiProvider`, alimentada por fixtures reais em `tests/providers/fixtures/{evolution,zapi}/`.
- **Captura ao vivo:** com as chaves do usuário, o agente conecta nas instâncias, envia/recebe mensagens de teste e todo webhook arquivado é sanitizado e promovido a fixture. Nunca escrever fixture inventada quando existir payload real. Durante o desenvolvimento local, webhooks chegam via túnel (cloudflared por padrão); com acessos do EasyPanel, o `apps/api` é deployado cedo para endpoint público estável.
- **Unidade:** máquina de estados da mensagem, resolução de telefone (E.164 + 9º dígito), dedupe/idempotência, normalização.
- Implementação com TDD (skill `superpowers:test-driven-development`).
- Regra permanente: todo bug de provider vira fixture; toda fixture vira teste.
- Mudança que tocar webhook/provider exige rodar a suíte de fixtures dos **dois** providers antes de concluir.

## 10. Documentação que nasce nesta entrega

- `docs/`: Vision, Architecture, Domain, Database, Conventions, Roadmap — densos e curtos (~30 páginas no total, máximo).
- `docs/adr/0001–0007`: tenancy, provider, webhook-contract, event-model/timeline, realtime, message-state, core-entities. Uma página cada (problema → decisão → consequências). A antecipação da Z-API para esta entrega é registrada como nota na ADR-0002.
- Ao final da fatia: `CLAUDE.md` enxugado para a forma definitiva (150–250 linhas), com ponteiros para docs/ADRs.

## 11. Sequenciamento e riscos

**Ordem interna:** fundação (monorepo, CI, db, tenancy, fila) → EvolutionProvider ponta-a-ponta até o critério de pronto → ZApiProvider contra a mesma suíte de contrato → docs finais + enxugar CLAUDE.md.

| Risco | Mitigação |
|---|---|
| Z-API antecipada ameaça o teto de ~2 semanas (Fatias 0+1) | Z-API só começa depois do ponta-a-ponta Evolution verde; se o teto estourar, corta-se fundação (ou a Z-API volta para a Fatia 4), nunca se estica prazo |
| Webhooks em dev local | Túnel cloudflared desde o dia 1; deploy cedo no EasyPanel quando os acessos chegarem |
| Redis do EasyPanel pendente | Docker local; connection string vira variável de ambiente, troca sem código |
| Credenciais em texto no banco | Cifradas na aplicação antes de persistir; chave de cifra em variável de ambiente |
| Payloads reais contêm dados pessoais | Sanitização obrigatória antes de promover a fixture (telefones e nomes trocados por valores sintéticos estáveis) |

## 12. Próximo passo

Plano de implementação detalhado via skill `superpowers:writing-plans`, quebrando esta entrega em tarefas com critérios verificáveis.
