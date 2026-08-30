# ADR-0003 — Webhooks: união normalizada, não um tipo só

**Data:** 2026-08-07 (semente) · **Status:** aceita — implementada na Fatia 1, provada com 23+ fixtures reais

## Problema

Cada provider entrega webhooks com shapes próprios, eventos duplicados, acks separados e pegadinhas aprendidas só em produção (mídia que chega depois do texto, resposta do próprio humano pelo celular, edições). Um "tipo único de webhook" esconderia essas semânticas e quebraria o histórico.

## Decisão

Endpoints por provider (`/webhooks/evolution`, `/webhooks/uazapi`; autorização por `webhook_token` da Company) convertem imediatamente para **três tipos internos** (schemas Zod em `packages/contracts`):

1. **IncomingMessage** — provider, providerMessageId, phone, conversationExternalId, tipo, text, media, timestamp, metadata. Campos obrigatórios aprendidos em produção: **`fromMe`** (resposta enviada pelo humano no celular DEVE entrar como outbound — senão o histórico mente e a IA responde por cima do humano); **chave de correlação de mídia** (áudio chega antes do texto; mídia chega depois); **referência de reply/quote**; **evento de edição** (a versão editada substitui a leitura, não a original).
2. **MessageStatusUpdate** — acks de delivered/read chegam como webhooks separados; alimentam a máquina de estados (ADR-0006).
3. **ConnectionStatusChange** — instância caiu/QR desconectou → alerta imediato ("instância morta em silêncio é o pior modo de falha"; limitação do caso processo-morto documentada em Domain.md).

Regras transversais: **todo webhook é idempotente** (dedupe por provider + providerMessageId + tipo de evento); **todo payload cru é arquivado** (`raw_webhook_events`) e vira candidato a fixture.

## Consequências

- O pipeline é testável por fixtures reais (parser TDD); bug de produção → fixture → teste, sem exceção (Conventions.md).
- Reprocessar raws (reconciliação de raws-veneno) é seguro por construção.
- Guarda de eco: o webhook do nosso próprio envio (mesmo providerMessageId) não cria linha nova; a UAZAPI adiciona o sinal explícito `wasSentByApi` (cobrir na suíte na Fatia 4 — ADR-0008).
- Achado registrado: a Evolution 2.3.7 NÃO emite evento de edição (2 tentativas controladas); verificar na UAZAPI (carry-over Fatia 4).
