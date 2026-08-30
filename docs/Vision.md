# Visão — Aios Pocket

## O que estamos construindo

Um **Operating System para empresas que vendem e atendem pelo WhatsApp** — não um conjunto de módulos independentes. CRM multi-tenant, SaaS, operado pela AIOS: a operação da AIOS usa a plataforma para atender os clientes dela e, com o tempo, os clientes dela usam a plataforma para atender os deles.

Tudo gira em torno de um **núcleo de identidade**: `Company`, `Channel` (ADR-0009), `Customer`, `Conversation`, `Message`, `TimelineEvent`. Os seis domínios do produto — **Atendimento, Agenda, Kanban, Follow-up, Campanhas, Relatórios** — referenciam esse núcleo; nunca o duplicam. Um cliente é UM registro, com UMA timeline, não importa por qual módulo ele passe.

## Princípios que não se negociam

- **Fatia vertical com critério de pronto demonstrável.** Cada fatia entrega valor ponta-a-ponta em infra real, com o piloto de testemunha — nunca "fundação" que ninguém usa. Se a fundação estoura o prazo, corta-se fundação, não se estica prazo.
- **Fixtures reais são patrimônio técnico.** Todo payload de provider vem de captura ao vivo; todo bug de produção vira fixture; toda fixtura vira teste. Em dois anos, essa suíte é o moat técnico do produto (docs/Conventions.md).
- **"Instância morta em silêncio é o pior modo de falha."** O produto existe porque empresas dependem do WhatsApp para vender; uma conexão caída sem alerta é receita perdida sem ninguém saber. Estado de conexão é cidadão de primeira classe (badge, eventos, e — futuro — watchdog ativo).
- **Rastreabilidade é inegociável.** `correlation_id` atravessa webhook → pipeline → mensagem → evento de timeline. Já vivemos o inferno de workflow disparando workflow sem trilha; não de novo.
- **Regra que máquina verifica não fica em prompt.** Enforcement mora no ESLint, nos testes de arquitetura e no CI (docs/Conventions.md §enforcement).

## Providers e canais

A comunicação com o WhatsApp passa pelo **Provider Pattern** (ADR-0002): hoje Evolution API (não-oficial, QR), na Fatia 4 a UAZAPI (ADR-0008), e na Fatia 9 o Zernio como relay da **API oficial da Meta** (templates, janela de 24h) mais o canal Instagram (ADR-0010). Cada conversa vive em exatamente um canal, cada canal tem exatamente um provider — nunca fallback automático entre eles (ADR-0009).

## Estado atual

**Fatia 1 completa e provada em produção** (2026-08-28): cliente piloto real na Evolution — mensagem real chega ao inbox em tempo real em `aios-pocket.vercel.app`, resposta pela UI chega no celular, resposta do próprio celular entra no histórico como "você — celular", timeline registra tudo, banner alerta desconexão. Evidências: `docs/superpowers/notes/2026-08-28-e2e-fatia-1.md`. Roadmap das próximas fatias: `docs/Roadmap.md`.
