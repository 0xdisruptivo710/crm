# ADR-0010 — Zernio: caminho para a API oficial da Meta (extensão de contrato, fatia própria)

**Data:** 2026-08-23 · **Status:** aceita (execução futura — Fatia 9) · **Complementa:** ADR-0008/0009

## Problema

Evolution e UAZAPI são APIs não-oficiais (whatsmeow/Baileys): sem janela de 24h, sem templates, com risco inerente de bloqueio de número. Campanhas em escala e contas comerciais sérias pedem a **Meta Cloud API oficial** — mas integrá-la direto exige gerenciar WABA, tokens, App Secret e aprovação de templates, um custo operacional que não queremos agora.

O **Zernio** (zernio.com) é um intermediário que relaya para a Cloud API: o cliente conecta o WhatsApp via Embedded Signup e nós usamos só uma API key. Traz também **Instagram** como canal de conversa e conexão com **Meta Ads**. Custo baixo (2 contas gratuitas; conexões adicionais baratas).

O perigo é fingir que é "mais um provider igual": a semântica oficial é outro animal — **janela de 24h** (mensagem livre só dentro dela; fora, só template aprovado pela Meta), categorias com pricing próprio, status de aprovação de template, tier/quality do número.

## Decisão

1. **Zernio entra no roadmap como fatia própria (Fatia 9)** — nunca como "plugin rápido" numa fatia de outra coisa.
2. Entra como `ZernioProvider` dentro do Provider Pattern (isolado em `packages/providers`), sobre um canal próprio (ADR-0009), **com extensão do contrato `MessagingProvider`**: capacidades declaradas por provider/canal (ex.: `hasMessagingWindow`, `supportsTemplates`) e as entidades/fluxos que a semântica oficial exige (template aprovado, estado da janela). O desenho fino da extensão é da fatia, não desta ADR.
3. **Instagram** entra como canal de conversa (provider zernio) — o núcleo já o acomoda via Channel.
4. **Meta Ads via Zernio NÃO é mensageria**: é fonte de dados de atribuição/custo para Campanhas/Relatórios (Fatias 7–8). Proibido modelá-la dentro de `MessagingProvider`.
5. Regras que permanecem invioladas: nunca fallback automático entre canais (oficial ↔ não-oficial têm semânticas incompatíveis); nenhum módulo de negócio conhece o Zernio; payloads do Zernio encontrados no Mega CRM estão marcados `ASSUMIDO` no código de lá — **não servem de fixture**; fixtures serão capturadas ao vivo na nossa conta.

## Consequências

- Ganho: caminho oficial sem gerenciar WABA/token; templates e broadcasts nativos; Instagram e Meta Ads com a mesma credencial; free tier paga o desenvolvimento.
- Risco aceito e mitigado: o Zernio é um SaaS terceiro — se morrer, o caminho oficial cai. O Provider Pattern limita o raio da explosão: trocá-lo por integração direta Meta (ou outro relay) é escrever outro provider, sem tocar domínio.
- O contrato `MessagingProvider` ganha o conceito de capacidades — Evolution/UAZAPI declaram `hasMessagingWindow: false`, e módulos de envio (campanhas, follow-up, IA) passam a respeitar a janela quando ela existir.
- Até a Fatia 9, nenhuma linha de código Zernio entra no repo.
