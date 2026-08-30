# Roadmap — por fatia vertical, nunca por módulo

Cada fatia entrega valor ponta-a-ponta em infra real e só começa quando a anterior bateu o critério de pronto. Revisão de 2026-08-23 (pivô pós-estudo do Mega CRM/Agentise — ADRs 0008/0009/0010) já refletida.

| Fatia | Entrega | Critério de pronto | Status |
|---|---|---|---|
| 0 | Monorepo, CI, Auth, TenantContext, camada de providers + normalização + fixtures, fila, eventos/idempotência | Enforcement mecânico rodando no CI | ✅ 2026-08-09 (Plano A) |
| 1 | Cliente piloto real na Evolution: recebe mensagem → inbox realtime → responde → Timeline registra | Mensagem real do piloto aparece no inbox; resposta enviada chega no celular dele | ✅ 2026-08-28 (Planos B+C; evidências em `superpowers/notes/2026-08-28-e2e-fatia-1.md`) |
| 2 | Contatos: identidade única, E.164, 9º dígito, tags | — | próxima |
| 3 | Kanban integrado ao Atendimento (Card referencia Customer/Conversation) | — | |
| 4 | **Channel no núcleo** (migração + backfill do canal Evolution default) + **UAZAPI como segundo provider** (ADR-0008/0009) | Mesma suíte de contrato passa nos dois providers | |
| 5 | Agenda | — | |
| 6 | Follow-up + **automações de funil** (gatilhos por etapa do Kanban) | — | |
| 7 | Campanhas | — | |
| 8 | Relatórios (+ **Meta Ads via Zernio** como fonte de atribuição/custo — não é mensageria, ADR-0010) | — | |
| 9 | **Zernio — API oficial Meta**: extensão do contrato MessagingProvider (janela 24h + templates) + canal Instagram (ADR-0010) | — | |
| 10 | **Agente IA + handoff IA↔humano** (posição negociável conforme prioridade do negócio) | — | |

## Regras do roadmap

- **Teto das Fatias 0+1**: ~2 semanas juntas. Estourou = fundação grande demais → cortar fundação, não esticar prazo. (Cumprido: 2026-08-08 → 2026-08-28, com pivô de arquitetura no meio.)
- **Nenhuma fatia N+1 começa sem o critério de pronto da N batido e demonstrado.**
- Cada fatia nasce com brainstorm → plano formal (`superpowers/plans/`) → execução com revisões → nota de evidência (`superpowers/notes/`) → carry-over triado → merge com CI verde.

## Blueprint de domínio para as Fatias 3/6/7/8

O schema do **Mega CRM/Agentise** (referência local do usuário, fora deste repo — **nunca commitar**) serve de blueprint de domínio: `deals`/`stages`/`pipelines` custom, `funnel_automations` (ações JSONB por etapa), `campaign_contacts` (fila de disparo com métricas por destinatário), `follow_up_rules` v2 (cadeias com cancelamento por resposta), métricas de dashboard/custos.

**Traduzir para o nosso núcleo e eventos; NUNCA copiar a arquitetura dele** (RLS como tenancy, pg_cron como fila, triggers HTTP — antíteses das nossas ADRs 0001/0004). Payloads Zernio de lá estão marcados "ASSUMIDO" no código — não usar como fixture; capturar ao vivo na nossa conta (Conventions.md).

## Carry-over

Itens triados entre fatias vivem em `superpowers/2026-08-08-plano-a-carryover.md` — todo plano novo DEVE consumir a lista dele ao ser escrito. Destaques abertos: fast-path de latência do realtime, watchdog de morte silenciosa da instância, rotação de credenciais (bloco 2026-08-28), migração do enum `zapi`→`uazapi` na Fatia 4.
