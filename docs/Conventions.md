# Convenções — Aios Pocket

## Código

- TypeScript `strict: true` em todos os packages; `any` proibido (ESLint).
- **Regra de negócio nunca em controller/route** — sempre em use cases/services (`apps/api/src/pipeline/`). Rotas só validam (Zod), autorizam e delegam.
- Todo endpoint nasce com **validação Zod**; schemas compartilhados em `packages/contracts` (web e api consomem os MESMOS schemas — o frontend valida a resposta da API com eles).
- Reutilizar antes de criar. **Nenhuma abstração sem necessidade comprovada por pelo menos dois usos reais.** Composição > herança; poucas abstrações bem definidas.
- Nunca duplicar lógica entre módulos — comportamento compartilhado pertence ao núcleo ou a um package.
- Toda operação lenta (envio, mídia, disparo, sync) vai para fila BullMQ. **Rota HTTP nunca espera provider.**
- Feature flag só para mudança arriscada de comportamento — não para toda feature.
- Código, comentários e documentação em **português**; identificadores em **inglês**.
- Eventos apenas ENTRE domínios; métodos síncronos DENTRO do domínio (ADR-0004).

## Fixtures reais = patrimônio técnico

- `tests/providers/fixtures/{evolution,uazapi}/` com payloads REAIS sanitizados, capturados ao vivo das nossas instâncias.
- **Todo bug de provider descoberto em produção vira fixture; toda fixture vira teste. Sem exceção.**
- **Nunca escrever fixture inventada quando existir payload real** — pedir/capturar antes de sintetizar. Payloads de terceiros marcados como assumidos (ex.: Zernio no Mega CRM) NÃO são fixture.
- A suíte de contrato de provider (`packages/providers/test/contract-suite.ts`) roda sobre as fixtures dos DOIS providers — é o critério de aceitação de provider novo (Fatia 4).

## Testes

- **TDD**: toda feature nasce com testes; bugfix nasce com teste que reproduz o bug.
- **Regra de processo (Critical do Plano A)**: toda costura entre tasks (auth→tenant, rota→fila, webhook→pipeline) ganha pelo menos **um teste happy-path mockado no mesmo plano** — só branches de erro testados deixam bugs de integração invisíveis a todas as revisões.
- Se a mudança tocar webhook/provider: rodar a suíte de fixtures dos DOIS providers antes de concluir.
- Se tocar agenda: verificar timezone, conflito e recorrência. Se tocar follow-up: regra de disparo, janela, limite e deduplicação.
- Testes de integração contra infra remota (droplet) recebem **timeout explícito** (o default de 5s do vitest flakeia por latência — lição de 2026-08-23).
- Testes destrutivos passam por `assertSafeToWipe` (Database.md §bancos); filas de teste usam Redis db 1.

## Enforcement mecânico (o que o CI verifica — regra que máquina verifica não fica em prompt)

- **ESLint**: proíbe `any`; proíbe import do Prisma client fora de `packages/db`; proíbe import/fetch de hosts Evolution/UAZAPI/Zernio fora de `packages/providers`.
- **Testes de arquitetura** (`tests/architecture/`): falham se um model Prisma nascer sem `company_id` (whitelist explícita) ou se um repository ignorar o TenantContext.
- **CI (GitHub Actions)**: typecheck + lint + testes + `db:deploy` + validação de drift de migrations em todo push/PR. **PR não passa, não mergeia.**
- Turbo em modo estrito: toda task que consome env precisa da lista em `tasks.<task>.env` do turbo.json (env entra na chave de cache).

## Processo de desenvolvimento

1. **Fatia vertical** (Roadmap.md) → brainstorm com o usuário → **plano formal** em `superpowers/plans/YYYY-MM-DD-*.md` (tasks bite-sized com testes).
2. **ADR antes de código** para toda alteração estrutural (entidade nova, mudança de contrato, dependência nova, provider novo). Decisões da arquitetura NÃO se rediscutem em conversa — revisá-las é escrever nova ADR.
3. Execução com revisões por task; achados viram fix waves ou **carry-over triado** (`superpowers/2026-08-08-plano-a-carryover.md`) — todo plano novo DEVE consumir a lista dele.
4. **Critério de pronto demonstrado em infra real** + nota de evidência em `superpowers/notes/` → merge com CI verde.
5. Antes de qualquer operação **em lote ou destrutiva** (migration com perda, backfill, disparo, cutover): apresentar o plano e aguardar aprovação explícita — checkpoints são parte do plano.
6. Commits frequentes, mensagens em português, prefixos `feat:`/`fix:`/`docs:`/`chore:`/`refactor:` com escopo quando útil.

## Operação e segurança

- Produção da operação (projeto `aios` no droplet) é INTOCÁVEL; nunca buildar imagem no droplet; nunca restart de host casual (Architecture.md §infra).
- Credenciais: só em `.env` (gitignored) e nos cofres das plataformas. **Nunca** em arquivo commitado, memória de agente ou chat — credencial que circulou está queimada e entra na fila de rotação (precedentes: 2026-08-10 e 2026-08-28).
- Mudança de schema no vivo: migração manual antes do redeploy (Architecture.md §runbook).
