CRM AIOS — Prompt Orquestrador v1.0



Como usar: copie este arquivo como CLAUDE.md na raiz do novo repositório da plataforma. Ele é o documento-semente: carrega as decisões de arquitetura até que docs/ e adr/ existam. A Primeira Missão (seção 7) manda o agente expandi-lo em documentação e depois enxugá-lo. Não edite as decisões da seção 3 sem criar uma ADR.



1. O que estamos construindo

Um Operating System para empresas que vendem e atendem pelo WhatsApp — não um conjunto de módulos independentes. CRM multi-tenant, SaaS, operado pela AIOS.

Tudo gira em torno de um núcleo de identidade: Company, Customer, Conversation, Message, TimelineEvent. Os seis domínios (Atendimento, Agenda, Kanban, Follow-up, Campanhas, Relatórios) referenciam esse núcleo — nunca o duplicam.

Você é o Arquiteto Principal deste produto. Sua missão é preservar consistência, simplicidade e a arquitetura decidida — não gerar código livremente.

2. Stack — INEGOCIÁVEL







Camada



Tecnologia



Deploy





Frontend



Next.js (App Router) + TypeScript + Tailwind + shadcn/ui



Vercel





Backend



Fastify + BullMQ + Prisma — um único deployable (API + workers no mesmo processo)



EasyPanel





Banco



Supabase Postgres (+ Auth, Storage, Realtime)



Supabase





Fila



BullMQ + Redis



EasyPanel





Monorepo



pnpm workspaces + Turborepo



—

Estrutura do monorepo:

apps/web            → Next.js (Vercel)
apps/api            → Fastify + workers BullMQ (EasyPanel, 1 processo)
packages/contracts  → schemas Zod compartilhados (tipos de API, eventos, webhooks normalizados)
packages/db         → schema Prisma + client extension de tenancy + repositories
packages/providers  → EvolutionProvider, UazapiProvider (futuro: ZernioProvider — ADR-0010), camada de normalização
docs/               → Vision, Architecture, Domain, Database, Conventions, Roadmap
docs/adr/           → uma decisão por arquivo, 1 página (problema → decisão → consequências)
tests/providers/fixtures/{evolution,uazapi}/ → payloads reais de webhook

Proibido: microsserviços, NestJS, servidor WebSocket próprio (v1), segundo deployable de backend.

3. Decisões de arquitetura JÁ TOMADAS — não rediscutir, apenas registrar em ADR

Revisão 2026-08-23 (pivô aprovado após estudo do Mega CRM/Agentise): ADR-0008 (UAZAPI substitui Z-API), ADR-0009 (Channel no núcleo) e ADR-0010 (Zernio/API oficial) já escritas em docs/adr/ — as seções 3.2 e 3.8 abaixo já as refletem.

3.1 Multi-tenant: Application Tenancy (ADR-0001)





Toda tabela de negócio tem company_id. Sem exceção não documentada.



Enforcement na aplicação: Prisma client extension injeta company_id obrigatório via TenantContext; todo acesso a dados passa por repositories.



RLS não é o mecanismo principal. Exceção única: políticas RLS read-only nas tabelas assinadas pelo Supabase Realtime (ver 3.7).



A service_role key do Supabase jamais chega ao frontend.

3.2 WhatsApp: Provider Pattern (ADR-0002)





Um único contrato interno: MessagingProvider. Implementações: EvolutionProvider e UazapiProvider (ADR-0008 — a Z-API saiu do roadmap sem código escrito). ZernioProvider (API oficial Meta via relay) entra na Fatia 9 com extensão de contrato — capacidades por provider, janela de 24h, templates (ADR-0010).



Cada Conversation vive em exatamente um Channel, e cada Channel tem exatamente um provider (ADR-0009). Uma Company pode ter N canais, inclusive de providers diferentes. Nunca dois providers na mesma conversa. Nunca fallback automático entre canais (semânticas diferentes quebrariam conversas no meio).



Nenhum módulo de negócio conhece Evolution, UAZAPI ou Zernio. Chamada direta às APIs deles fora de packages/providers é violação de arquitetura.



Só existem os providers registrados por ADR: hoje Evolution e UAZAPI, com Zernio previsto pela ADR-0010. Provider novo (inclusive a volta da Z-API) exige nova ADR.

3.3 Webhooks: união normalizada, não um tipo só (ADR-0003)

Endpoints por provider (/webhooks/evolution, /webhooks/uazapi) convertem imediatamente para três tipos internos:





IncomingMessage — provider, providerMessageId, phone, conversationExternalId, tipo, text, media, timestamp, metadata. Campos obrigatórios aprendidos em produção:





fromMe: resposta enviada pelo humano no celular chega via webhook e DEVE entrar na conversa como outbound (senão o histórico mente e a IA responde por cima do humano);



chave de correlação de mídia (áudio chega antes do texto; mídia chega depois);



referência de reply/quote;



evento de edição (a versão editada substitui a leitura, não a original).



MessageStatusUpdate — acks de delivered/read chegam como webhooks separados; alimentam a máquina de estados da mensagem.



ConnectionStatusChange — instância caiu/QR desconectou → alerta imediato. Instância morta em silêncio é o pior modo de falha do produto.

Todo webhook é idempotente (dedupe por provider + providerMessageId + tipo de evento). Todo payload cru é arquivado e vira candidato a fixture.

3.4 Mensagens: uma tabela, uma máquina de estados (ADR-0006)





Existe uma tabela messages. Não existe inbox/outbox separados.



Estados: received | queued | sending | sent | delivered | read | failed.



Transições registradas como TimelineEvents.

3.5 Timeline = Event Log do cliente (ADR-0004)





Tabela customer_events append-only: company_id, customer_id, type, payload, schema_version, occurred_at, correlation_id.



A Timeline (tela) é apenas uma query sobre essa tabela. Ela serve simultaneamente: histórico, auditoria, analytics e contexto para IA.



É um log, NÃO event sourcing. O estado vive nas tabelas de domínio; eventos nunca são fonte de verdade nem base para reconstrução de estado. Qualquer deslize nessa direção é violação de arquitetura.



Todo payload de evento carrega schema_version desde o evento nº 1.

3.6 Comunicação entre módulos (ADR-0004)





Dentro do mesmo domínio: chamada direta (método/use case). Conversation criar Message não precisa de evento.



Entre domínios: evento. AppointmentCreated → Follow-up reage, Timeline registra, Analytics contabiliza, IA recebe contexto.



Eventos são publicados depois do commit; consumers são idempotentes; correlation_id em tudo (rastreabilidade é inegociável — já vivemos o inferno de workflow disparando workflow sem trilha).

3.7 Realtime: Supabase Realtime na v1 (ADR-0005)





Frontend assina messages e conversations via Supabase Realtime, com políticas RLS read-only só nessas tabelas.



WebSocket próprio apenas se surgir motivo técnico real — e exige nova ADR.

3.8 Entidades: núcleo + domínio (ADR-0007)





Núcleo de identidade (estável, nunca muda de responsabilidade): Company, Channel (ADR-0009 — entra na Fatia 4 com backfill do canal Evolution default), Customer, Conversation, Message, TimelineEvent.



Entidades de domínio (referenciam o núcleo): Appointment, Card (oportunidade — um cliente tem várias ao longo do tempo; valor, etapa, ganho/perda vivem aqui), FollowupFlow/FollowupExecution, Campaign.



PROIBIDO criar uma entidade Task genérica que engula agendamento, follow-up e lembrete. São entidades diferentes com semânticas diferentes. Visão unificada de pendências, se necessária um dia, é projeção de leitura sobre a Timeline — não entidade.

3.9 Telefone: identidade canônica (Domain.md)





Formato canônico: E.164. Original do provider sempre preservado em campo próprio.



Matching considera a regra do 9º dígito brasileiro (mesmo cliente com e sem o 9).



Customer é resolvido/criado na chegada de qualquer mensagem — a decisão vale desde a Fatia 1.

3.10 Fixtures reais = patrimônio técnico (Conventions.md)





tests/providers/fixtures/{evolution,uazapi}/ com payloads reais sanitizados.



Todo bug de provider descoberto em produção vira fixture; toda fixture vira teste. Sem exceção. Em dois anos, essa suíte é o moat técnico do produto.

4. Regras de operação do agente (não mecanizáveis — memorize)





Nunca colocar regra de negócio em controller/route — sempre em use cases/services.



Reutilizar antes de criar. Nunca adicionar abstração sem necessidade comprovada por pelo menos dois usos reais.



Toda alteração estrutural (entidade nova, mudança de contrato, dependência nova) exige ADR antes do código.



Preferir composição a herança. Preferir poucas abstrações bem definidas.



Eventos apenas entre domínios; métodos síncronos dentro do domínio (seção 3.6).



Nunca duplicar lógica entre módulos — se dois domínios precisam do mesmo comportamento, ele pertence ao núcleo ou a um package compartilhado.



Toda operação lenta (envio, mídia, disparo, sync) vai para fila BullMQ. Rota HTTP nunca espera provider.



Feature flag apenas para mudança arriscada de comportamento — não para toda feature.



Antes de qualquer operação em lote ou destrutiva (migration com perda, backfill, disparo), apresentar o plano e aguardar aprovação.



Toda feature nasce com testes; todo endpoint nasce com validação Zod (schemas em packages/contracts, compartilhados entre web e api).



Se a mudança tocar webhook/provider, rodar a suíte de fixtures dos DOIS providers antes de concluir.



Se a mudança tocar agenda: verificar timezone, conflito e recorrência. Se tocar follow-up: verificar regra de disparo, janela, limite e deduplicação.



Código, comentários e documentação em português; identificadores em inglês.

5. Enforcement mecânico (montar na Fatia 0 — regra que máquina verifica não fica em prompt)





ESLint: proibir any; proibir import do Prisma client fora de packages/db; proibir import/fetch de hosts Evolution/UAZAPI/Zernio fora de packages/providers.



Testes de arquitetura: falha se um model Prisma nascer sem company_id (whitelist explícita para tabelas globais); falha se um repository ignorar o TenantContext.



CI (GitHub Actions): typecheck + lint + testes + validação de migrations em todo PR. PR não passa, não mergeia.



TypeScript strict: true em todos os packages.

6. Roadmap — por fatia vertical, nunca por módulo







Fatia



Entrega



Critério de pronto





0



Monorepo, CI, Auth, TenantContext, camada de providers + normalização + fixtures, fila, eventos/idempotência



Enforcement da seção 5 rodando no CI





1



Cliente piloto real na Evolution: recebe mensagem → inbox realtime → responde → Timeline registra



Mensagem real do piloto aparece no inbox; resposta enviada chega no celular dele





2



Contatos: identidade única, E.164, 9º dígito, tags









3



Kanban integrado ao Atendimento (Card referencia Customer/Conversation)









4



Channel no núcleo (migração + backfill) + UAZAPI como segundo provider (ADR-0008/0009)



Mesma suíte de testes passa nos dois providers





5



Agenda









6



Follow-up + automações de funil (gatilhos por etapa do Kanban)









7



Campanhas









8



Relatórios (+ Meta Ads via Zernio como fonte de atribuição/custo — não é mensageria, ADR-0010)





9



Zernio — API oficial Meta: extensão do contrato MessagingProvider (janela 24h + templates) + canal Instagram (ADR-0010)





10



Agente IA + handoff IA↔humano (posição negociável conforme prioridade do negócio)





Fatias 0+1 juntas têm teto de ~2 semanas. Se estourar, a fundação está grande demais — cortar fundação, não esticar prazo. Nenhuma fatia N+1 começa com a N sem critério de pronto batido.

Blueprint de domínio para as Fatias 3/6/7/8: o schema do Mega CRM/Agentise (referência local do usuário, fora deste repo — nunca commitar) — deals/stages/pipelines, funnel_automations, campaign_contacts, follow_up_rules v2, métricas. Traduzir para o nosso núcleo e eventos; NUNCA copiar a arquitetura dele (RLS como tenancy, pg_cron como fila, triggers HTTP). Payloads Zernio de lá estão marcados "ASSUMIDO" — não usar como fixture.

7. Primeira Missão (execute nesta ordem ao encontrar este arquivo num repo vazio)





Brainstorm + plano (use as skills superpowers: brainstorming → writing-plans) da Fatia 0, validando com o usuário nome do produto, cliente piloto e credenciais disponíveis.



Gerar docs/ a partir da seção 3: Vision.md, Architecture.md, Domain.md, Database.md, Conventions.md, Roadmap.md. Documentos densos e curtos — o total não passa de ~30 páginas.



Escrever as 7 ADRs (docs/adr/0001 a 0007): tenancy, provider, webhook-contract, event-model/timeline, realtime, message-state, core-entities. Uma página cada: problema → decisão → consequências. As ADRs 0008–0010 (pivô de 2026-08-23) já existem — 0002 e 0007 devem nascer coerentes com elas.



Esqueleto do monorepo (seção 2) + enforcement mecânico (seção 5) + CI verde.



Fatia 1 com TDD sobre fixtures reais (superpowers: test-driven-development), terminando no critério de pronto da tabela.



Em paralelo e fora deste repo: a operação já captura payloads crus de webhook via n8n para popular fixtures/ — pedir os arquivos ao usuário antes de inventar payload sintético. Nunca escrever fixture inventada quando existir payload real.

8. Ciclo de vida deste documento

Depois que docs/ e adr/ existirem (fim da Fatia 0), enxugue este arquivo: ele vira o CLAUDE.md definitivo com apenas as seções 4, 5 (como referência) e ponteiros para os docs — alvo de 150–250 linhas. Arquitetura mora em docs/Architecture.md; decisão mora em ADR; regra mecanizável mora no lint/CI. Este arquivo guarda só o que a IA precisa lembrar e que nenhuma ferramenta consegue verificar.