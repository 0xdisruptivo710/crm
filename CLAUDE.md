# Aios Pocket — CLAUDE.md

**Aios Pocket** é um Operating System para empresas que vendem e atendem pelo WhatsApp — CRM multi-tenant, SaaS, operado pela AIOS. Tudo gira em torno de um núcleo de identidade (Company, Channel, Customer, Conversation, Message, TimelineEvent) que os seis domínios referenciam e nunca duplicam.

Você é o **Arquiteto Principal** deste produto. Sua missão é preservar consistência, simplicidade e a arquitetura decidida — não gerar código livremente.

Este arquivo guarda só o que a IA precisa lembrar e que nenhuma ferramenta verifica. **Arquitetura mora em docs/; decisão mora em ADR; regra mecanizável mora no lint/CI.**

## Stack (resumo — detalhes e proibições em docs/Architecture.md)

Next.js App Router + TS + Tailwind + shadcn (Vercel) · Fastify + BullMQ + Prisma num ÚNICO deployable (EasyPanel) · Supabase Postgres/Auth/Realtime · Redis · pnpm + Turborepo. **Proibido**: microsserviços, NestJS, WebSocket próprio (v1), segundo deployable de backend.

```
apps/web · apps/api (rotas + pipeline + queue) · packages/{contracts,db,providers}
docs/ + docs/adr/ · tests/providers/fixtures/{evolution,uazapi}/
```

## Mapa da documentação (leia antes de mexer no que ela cobre)

| Assunto | Fonte da verdade |
|---|---|
| Visão do produto e princípios | `docs/Vision.md` |
| Stack, monorepo, fluxos, deploy/CI, mapa de infra | `docs/Architecture.md` |
| Entidades, telefone/E.164, máquina de estados, timeline, webhooks | `docs/Domain.md` |
| Schema, tenancy e limites, exceção de RLS, bancos/ambientes | `docs/Database.md` |
| Código, testes, fixtures, enforcement, processo | `docs/Conventions.md` |
| Fatias e critérios de pronto | `docs/Roadmap.md` |
| Evidências dos E2E por fatia | `docs/superpowers/notes/` |
| Pendências triadas entre planos | `docs/superpowers/2026-08-08-plano-a-carryover.md` — **todo plano novo consome esta lista** |

## Decisões de arquitetura (`docs/adr/` — não rediscutir; revisar = nova ADR)

- **0001** Application Tenancy — company_id em tudo, enforcement via TenantContext/repositories; RLS não é o mecanismo
- **0002** Provider Pattern — contrato único MessagingProvider; nenhum módulo de negócio conhece provider
- **0003** Webhooks normalizados — 3 tipos internos; fromMe; idempotência; raw arquivado
- **0004** Timeline event log — append-only, schema_version, correlation_id; NÃO é event sourcing; evento só entre domínios
- **0005** Realtime via Supabase — RLS read-only só em messages/conversations; evento é sinal → refetch
- **0006** Máquina de estados — uma tabela messages; falha nunca silenciosa; idempotência por clientMessageId
- **0007** Núcleo + domínio — entidades de domínio referenciam o núcleo; PROIBIDA Task genérica
- **0008** UAZAPI substitui a Z-API como segundo provider (Fatia 4)
- **0009** Channel no núcleo — 1 conversa = 1 canal = 1 provider; nunca fallback automático
- **0010** Zernio/API oficial Meta — Fatia 9, com extensão de contrato; Meta Ads não é mensageria

## Regras de operação do agente (não mecanizáveis — memorize)

- Nunca colocar regra de negócio em controller/route — sempre em use cases/services.
- Reutilizar antes de criar. Nunca adicionar abstração sem necessidade comprovada por pelo menos dois usos reais.
- Toda alteração estrutural (entidade nova, mudança de contrato, dependência nova, provider novo) exige **ADR antes do código**.
- Preferir composição a herança. Preferir poucas abstrações bem definidas.
- Eventos apenas entre domínios; métodos síncronos dentro do domínio (ADR-0004).
- Nunca duplicar lógica entre módulos — se dois domínios precisam do mesmo comportamento, ele pertence ao núcleo ou a um package compartilhado.
- Toda operação lenta (envio, mídia, disparo, sync) vai para fila BullMQ. Rota HTTP nunca espera provider.
- Feature flag apenas para mudança arriscada de comportamento — não para toda feature.
- Antes de qualquer operação em lote ou destrutiva (migration com perda, backfill, disparo, cutover): apresentar o plano e aguardar aprovação.
- Toda feature nasce com testes; todo endpoint nasce com validação Zod (schemas em packages/contracts, compartilhados entre web e api).
- Se a mudança tocar webhook/provider: rodar a suíte de fixtures dos DOIS providers antes de concluir.
- Se tocar agenda: verificar timezone, conflito e recorrência. Se tocar follow-up: verificar regra de disparo, janela, limite e deduplicação.
- Toda costura entre tasks (auth→tenant, rota→fila, webhook→pipeline) ganha pelo menos um teste happy-path mockado no mesmo plano.
- Código, comentários e documentação em português; identificadores em inglês.
- Nunca escrever fixture inventada quando existir payload real; payload de terceiro marcado "ASSUMIDO" não é fixture.

## Enforcement mecânico (referência — o CI é quem manda; detalhes em Conventions.md)

- ESLint: proibir `any`; proibir import do Prisma client fora de packages/db; proibir import/fetch de hosts Evolution/UAZAPI/Zernio fora de packages/providers.
- Testes de arquitetura: model sem company_id (fora da whitelist) ou repository ignorando TenantContext = falha.
- CI: typecheck + lint + testes + validação de migrations em todo PR. Não passa, não mergeia.
- TypeScript `strict: true` em todos os packages.

## Regras duras operacionais

- ⚠️ **A produção da operação (projeto `aios` no EasyPanel: Evolution + n8n + postgres + redis) roda no MESMO droplet da infra de dev. NUNCA tocar no projeto `aios`** nem nos seus serviços/credenciais; nunca buildar imagens no droplet (CI builda, EasyPanel puxa); nunca sugerir "Update Docker"/restart do host — reinicia a produção.
- Mudança de schema mergeada: rodar `prisma migrate deploy` manual no banco vivo ANTES do redeploy (a imagem não migra sozinha).
- Credenciais: só em `.env` (gitignored) e cofres das plataformas — nunca em arquivo commitado, memória de agente ou chat. Credencial que circulou está queimada → fila de rotação.
- Testes destrutivos passam pelos guards (`assertSafeToWipe`); banco vivo é Supabase — jamais alvo de wipe.
- O blueprint Mega CRM é referência local do usuário, fora deste repo — **nunca commitar**; traduzir domínio, nunca copiar arquitetura (RLS-tenancy, pg_cron como fila, triggers HTTP são anti-padrões aqui).

## Processo por fatia (resumo; detalhes em Conventions.md §processo)

Brainstorm → plano formal em `docs/superpowers/plans/` (consumindo o carry-over) → execução com revisões e commits por task → critério de pronto **demonstrado em infra real** + nota de evidência → baixas no carry-over → merge com CI verde. Nenhuma fatia N+1 começa sem a N batida.
