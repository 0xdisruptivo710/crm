# ADR-0002 — WhatsApp via Provider Pattern

**Data:** 2026-08-07 (semente) · **Status:** aceita — implementada na Fatia 0/1 (Evolution); revisada por ADR-0008/0009/0010

## Problema

O produto fala com o WhatsApp por APIs de terceiros com semânticas diferentes (não-oficiais estilo Baileys hoje; oficial Meta no futuro). Acoplar módulos de negócio a uma API específica tornaria cada troca/adição de provider uma reescrita.

## Decisão

1. **Um único contrato interno: `MessagingProvider`** (`packages/providers`), com camada de normalização de webhooks (ADR-0003).
2. **Nenhum módulo de negócio conhece Evolution, UAZAPI ou Zernio.** Chamada direta às APIs deles fora de `packages/providers` é violação de arquitetura — enforced por ESLint (proibição de import/fetch dos hosts).
3. **Só existem os providers registrados por ADR**: Evolution (Fatia 1, em produção), UAZAPI (Fatia 4 — ADR-0008; substituiu a Z-API, que saiu do roadmap sem código escrito), Zernio (Fatia 9 — ADR-0010, com extensão de contrato para a semântica oficial: capacidades por provider, janela de 24h, templates). Provider novo — inclusive a volta da Z-API — exige nova ADR.
4. Vínculo provider↔conversa: cada Conversation vive em exatamente um Channel e cada Channel tem exatamente um provider (ADR-0009). Nunca dois providers na mesma conversa; nunca fallback automático entre canais.

## Consequências

- A **suíte de contrato** (`packages/providers/test/contract-suite.ts`), rodando sobre fixtures reais dos dois providers, é o critério de aceitação de qualquer implementação nova (critério da Fatia 4: "mesma suíte passa nos dois").
- Trocar/adicionar provider é escrever uma implementação + capturar fixtures — domínio intocado. Provado no pivô de 2026-08-23: a Z-API saiu do roadmap com custo zero de código.
- Dependências de SaaS intermediário (Zernio) ficam com raio de explosão limitado ao package (ADR-0010).
