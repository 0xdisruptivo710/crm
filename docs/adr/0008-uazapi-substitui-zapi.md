# ADR-0008 — UAZAPI substitui a Z-API como segundo provider

**Data:** 2026-08-23 · **Status:** aceita · **Revisa:** seção 3.2 do CLAUDE.md semente (decisão que a ADR-0002 registrará)

## Problema

O plano original fixava Evolution + Z-API como os dois únicos providers ("Não existe WTSProvider e não existirá"), com a Z-API entrando na Fatia 4. Nenhuma linha de código da Z-API foi escrita — hoje ela existe apenas como enum no Prisma (`provider.zapi`), um short-circuit em `provider-factory.ts` e itens de carry-over.

O estudo do Mega CRM/Agentise (2026-08-23) trouxe fatos novos: a UAZAPI é concorrente direta da Z-API, da mesma família técnica da Evolution (whatsmeow/Baileys — QR, `fromMe`, sem janela de 24h), tem integração nativa na plataforma Zernio (que entra no nosso roadmap, ver ADR-0010) e temos código de produção de referência com os shapes reais de payload dela (client, webhook, anti-loop `wasSentByApi`, parsing de JID, `/chat/details` com foto de perfil do lead — dado que nem a API oficial expõe).

## Decisão

1. **A Z-API sai do roadmap. A UAZAPI é o segundo provider** (Fatia 4): `UazapiProvider` implementando o mesmo contrato `MessagingProvider`, validado pela mesma suíte de contrato da Evolution.
2. A frase da seção 3.2 passa a ser: só existem os providers registrados por ADR — hoje Evolution e UAZAPI, com Zernio previsto pela ADR-0010. Z-API só volta se um cliente exigir, via nova ADR.
3. O código do Mega CRM serve como **referência de estrutura** (endpoints `POST /send/text`, `POST /send/media`, `POST /chat/details`; auth via header `token:`; webhook `{event, instance, data.message}` com `messageid/chatid/sender/fromMe/messageType/fileURL/wasSentByApi`) — **nunca como fixture**. Fixtures da UAZAPI serão capturadas ao vivo da nossa instância, como foi feito na Evolution (seção 3.10).

## Consequências

- Fatia 4 fica mais barata: semânticas irmãs da Evolution, payloads de referência conhecidos, mesmo modelo de conexão (QR/instância).
- Migração de schema na Fatia 4: enum `provider` do Prisma troca `zapi` → `uazapi` (nenhuma linha usa `zapi`; migração trivial). O short-circuit em `provider-factory.ts` muda de mensagem.
- Itens de carry-over que citavam `ZApiProvider` mudam de alvo para `UazapiProvider` (vocabulário da contract-suite; verificação de evento de edição — a Evolution 2.3.7 não emite, verificar se a UAZAPI emite).
- ESLint da seção 5 passa a proibir hosts UAZAPI (no lugar de Z-API) fora de `packages/providers`.
- Anti-eco: a UAZAPI marca `wasSentByApi` no webhook do próprio envio — a guarda de eco do pipeline (hoje calibrada para a Evolution) ganha um sinal explícito a mais; registrar na suíte de contrato.
