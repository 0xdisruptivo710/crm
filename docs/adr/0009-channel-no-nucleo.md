# ADR-0009 — Channel entra no núcleo de identidade

**Data:** 2026-08-23 · **Status:** aceita · **Revisa:** seções 3.2 e 3.8 do CLAUDE.md semente (ADR-0002/0007)

## Problema

O modelo original assumia **um provider ativo por tenant**: a Company tem uma conexão de WhatsApp e ponto. Isso não sobrevive ao produto real: empresas têm N números (número compartilhado da equipe + número pessoal de vendedor), o Zernio (ADR-0010) traz Instagram como canal de conversa, e recursos por número (responsável fixo, IA ligada/desligada por número — validados em produção pelo Mega CRM) não têm onde morar. Sem uma entidade própria, cada domínio inventaria seu jeito de referenciar "por onde essa conversa passa".

## Decisão

1. **`Channel` entra no núcleo de identidade**: Company 1—N Channels. Cada Channel tem `provider` (evolution | uazapi | zernio — enum controlado por ADR), credenciais/config cifradas por linha, identificador externo (instância/conta), status de conexão e espaço para atributos por canal (ex.: responsável padrão, IA habilitada — campos entram nas fatias que os usarem, não antes).
2. **`Conversation.channelId` obrigatório**: toda conversa nasce e vive em exatamente um canal.
3. **A regra sagrada muda de altitude, não de conteúdo**: "nunca dois providers simultâneos, nunca fallback automático" passa do tenant para o **canal** — uma conversa nunca troca de canal/provider no meio (semânticas diferentes quebrariam a conversa). Uma Company pode ter canais de providers diferentes ao mesmo tempo; o que é proibido é misturá-los na mesma conversa ou failover automático entre eles.
4. **Quando:** a entidade entra na **Fatia 4**, junto com o segundo provider — antes disso seria abstração com um único uso (regra §4). Backfill: toda Conversation existente aponta para o canal Evolution default criado por Company.
5. `ConnectionStatusChange` (ADR-0003) passa a referenciar o canal — o alerta de "instância morta" é por canal.

## Consequências

- O núcleo passa a ser: **Company, Channel, Customer, Conversation, Message, TimelineEvent**.
- `TenantContext`/tenancy não mudam (o canal é filho da Company; `company_id` continua em tudo).
- Config de provider por tenant (hoje colunas/segredos da Company) migra para a linha do Channel na Fatia 4.
- Roteamento de webhook ganha resolução de canal (endpoint por provider + identificador da instância → Channel), não mais "o provider do tenant".
- Fatias 6–8 (follow-up, campanhas, relatórios) e o handoff de IA ganham dimensão natural "por canal" sem retrabalho de modelo.
- Custo aceito: uma migração + backfill na Fatia 4 (trivial no volume atual) e um conceito a mais no domínio — pago uma vez, evita N gambiarras.
