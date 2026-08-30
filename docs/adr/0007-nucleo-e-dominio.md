# ADR-0007 — Entidades: núcleo de identidade + entidades de domínio

**Data:** 2026-08-07 (semente) · **Status:** aceita — núcleo implementado na Fatia 1; revisada por ADR-0009 (Channel)

## Problema

Seis domínios (Atendimento, Agenda, Kanban, Follow-up, Campanhas, Relatórios) precisam falar do MESMO cliente e da MESMA conversa. Sem um núcleo explícito, cada módulo inventa sua cópia de "contato"/"tarefa" e o produto vira ilhas — o defeito clássico dos CRMs de módulos.

## Decisão

1. **Núcleo de identidade** (estável, nunca muda de responsabilidade): `Company`, `Channel` (ADR-0009 — entra na Fatia 4 com backfill do canal Evolution default), `Customer`, `Conversation`, `Message`, `TimelineEvent`.
2. **Entidades de domínio referenciam o núcleo, nunca o duplicam**: `Appointment` (Agenda), `Card` (Kanban — oportunidade: um cliente tem VÁRIAS ao longo do tempo; valor, etapa, ganho/perda vivem no Card, não no Customer), `FollowupFlow`/`FollowupExecution`, `Campaign`.
3. **PROIBIDO criar uma entidade `Task` genérica** que engula agendamento, follow-up e lembrete. São entidades diferentes com semânticas diferentes (timezone/recorrência ≠ regra de disparo/janela ≠ checklist). Visão unificada de pendências, se necessária um dia, é **projeção de leitura sobre a Timeline** — não entidade.
4. Identidade da pessoa é canônica por telefone (E.164 + regra do 9º dígito — Domain.md); `Customer` é resolvido/criado na chegada de qualquer mensagem, desde a Fatia 1.

## Consequências

- Cada fatia nova (2–10) começa referenciando o núcleo — zero migração de identidade entre módulos.
- O blueprint do Mega CRM para Kanban/Follow-up/Campanhas/Relatórios é **traduzido** para este núcleo (deals→Card referenciando Customer/Conversation etc.), nunca copiado com a identidade própria dele (Roadmap.md §blueprint).
- A proibição da Task genérica tem custo consciente: três telas de "pendências" separadas até que uma projeção de leitura se justifique — preferível a uma entidade-Deus com semântica de ninguém.
