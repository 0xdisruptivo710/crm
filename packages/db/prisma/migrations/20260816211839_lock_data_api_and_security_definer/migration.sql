-- Task 2 (Plano C), Fix round 1 — corrige 1 Critical + 1 Important encontrados na revisão
-- da migração 20260816204632_rls_realtime. Migração ADITIVA: a anterior já está aplicada
-- nos dois bancos (droplet-test e Supabase) e continua correta como está — este arquivo só
-- FECHA duas lacunas que ficaram em torno dela.
--
-- CRITICAL corrigido: todo projeto Supabase novo configura, por padrão, privilégios via
-- ALTER DEFAULT PRIVILEGES concedendo SELECT/INSERT/UPDATE/DELETE/TRUNCATE nas tabelas do
-- schema "public" às roles "anon" e "authenticated" (é assim que a Data API/PostgREST
-- funciona fora da caixa). As 8 tabelas deste produto nasceram assim via `migrate deploy`
-- — só messages/conversations ganharam RLS na migração anterior. Na prática, isso deixava
-- companies (webhook_token, provider_credentials!), users, customers, customer_events e
-- raw_webhook_events acessíveis via PostgREST com a ANON KEY pública, sem RLS nenhuma
-- barrando (RLS desabilitado = tabela 100% visível para quem tem privilégio). Provado em
-- revisão: POST via PostgREST com anon key nessas 5 tabelas chegava até a checagem de
-- constraint (23502), não barrava em permissão — e o pior: como a policy de
-- messages/conversations só validava company_id contra a linha de `users` do próprio
-- auth.uid(), um atacante conseguia LER companies.id de outro tenant (GET público) e
-- INSERIR em users {auth_user_id: <uid do próprio atacante>, company_id: <da vítima>} —
-- virando "membro" legítimo daquele tenant aos olhos da policy e enxergando toda a Timeline
-- alheia via Realtime. Fechado abaixo: REVOKE ALL de anon/authenticated em TODAS as tabelas
-- existentes + ALTER DEFAULT PRIVILEGES para que tabelas FUTURAS também nasçam fechadas +
-- GRANT SELECT pontual em messages/conversations (a exceção do ADR-0005, e SÓ ela — nenhuma
-- outra tabela recebe grant de volta). authenticated precisa do SELECT para o Realtime
-- funcionar (é quem lê de verdade, filtrado pela policy). anon TAMBÉM recebe SELECT aqui —
-- não por confiar em anon, mas por um detalhe empírico do Realtime do Supabase descoberto
-- nesta correção (ver nota "Achado empírico" mais abaixo, antes do bloco 3): quando o role
-- do assinante NÃO tem SELECT na tabela, o Postgres nega a query de recheck com erro de
-- permissão, e o Realtime propaga isso como um evento com `record: {}` + `errors: ["Error
-- 401: Unauthorized"]` em vez de simplesmente não entregar nada — nenhum dado real vaza
-- (nem uma coluna), mas o canal deixa de ficar em silêncio perfeito. Com SELECT concedido +
-- ZERO policy para anon, RLS nega a linha da forma "normal" (0 linhas devolvidas, sem
-- erro) e o Realtime corretamente não entrega evento nenhum — o mesmo comportamento já
-- provado no relatório original da Task 2. anon continua SEM INSERT/UPDATE/DELETE em
-- messages/conversations (só o SELECT some do REVOKE ALL) e SEM QUALQUER privilégio nas
-- outras 6 tabelas.
--
-- IMPORTANT corrigido: a policy anterior usava `company_id IN (SELECT company_id FROM users
-- WHERE auth_user_id = auth.uid())` executando como o role INVOCADOR (authenticated) — ou
-- seja, a policy dependia de um invariante invisível (public.users legível por
-- authenticated, sem RLS própria) que nada nesta migração documentava nem protegia; ligar
-- RLS em users no futuro (parece a coisa "certa" a se fazer, ironicamente) ou revogar
-- SELECT dela mataria a entrega de eventos do Realtime EM SILÊNCIO (nenhum erro, só zero
-- eventos). Fechado abaixo com uma função SECURITY DEFINER: ela roda com os privilégios do
-- DONO da função (postgres, que sempre enxerga users independente de RLS/grants futuros em
-- cima da tabela), então a policy passa a ter uma dependência estável e explícita, e não
-- mais um acoplamento silencioso ao estado de permissões de outra tabela.

-- === 1) Função SECURITY DEFINER — só existe onde auth.uid() existe (Supabase) ===
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN

    -- Guarda extra além do CREATE OR REPLACE (que já é idempotente por natureza para
    -- funções): checagem explícita em pg_proc para manter o mesmo estilo de guarda usado
    -- no resto do arquivo/migração anterior (CREATE POLICY e ALTER PUBLICATION ADD TABLE
    -- não são idempotentes por si só; esta aqui documenta a idempotência em vez de confiar
    -- implicitamente no comportamento do CREATE OR REPLACE).
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'current_company_id'
    ) THEN
      CREATE FUNCTION public.current_company_id()
      RETURNS uuid
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $fn$
        SELECT company_id FROM users WHERE auth_user_id = auth.uid()
      $fn$;
    ELSE
      -- já existe (segunda aplicação/replay) — CREATE OR REPLACE garante que a definição
      -- fique idêntica à desta migração, sem duplicar o objeto.
      CREATE OR REPLACE FUNCTION public.current_company_id()
      RETURNS uuid
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $fn$
        SELECT company_id FROM users WHERE auth_user_id = auth.uid()
      $fn$;
    END IF;

    -- SECURITY DEFINER roda com os privilégios de quem CRIOU a função (postgres) — não do
    -- invocador. Sem essas revogações, qualquer role com EXECUTE ganharia, de graça, uma
    -- forma de ler users através da função mesmo se users nunca tiver SELECT concedido
    -- diretamente. REVOKE ALL FROM PUBLIC fecha a porta para toda role por padrão; o GRANT
    -- EXECUTE abaixo reabre só para authenticated, que é quem a policy realmente invoca.
    REVOKE ALL ON FUNCTION public.current_company_id() FROM PUBLIC;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON FUNCTION public.current_company_id() FROM anon;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      GRANT EXECUTE ON FUNCTION public.current_company_id() TO authenticated;
    END IF;

  END IF;
END $$;

-- === 2) Policies trocadas para usar a função SECURITY DEFINER ===
-- DROP + CREATE (em vez de ALTER) porque a USING clause muda; idempotente por construção
-- (DROP POLICY IF EXISTS nunca falha, CREATE POLICY sempre recria do zero).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN

    DROP POLICY IF EXISTS "realtime_read_messages" ON "public"."messages";
    CREATE POLICY "realtime_read_messages" ON "public"."messages" FOR SELECT TO authenticated
      USING (company_id = public.current_company_id());

    DROP POLICY IF EXISTS "realtime_read_conversations" ON "public"."conversations";
    CREATE POLICY "realtime_read_conversations" ON "public"."conversations" FOR SELECT TO authenticated
      USING (company_id = public.current_company_id());

  END IF;
END $$;

-- Achado empírico (validado com logger verboso do realtime-js contra o Supabase real):
-- quando o subscriber do Realtime tem ZERO privilégio de tabela (nem SELECT) na tabela
-- assinada, o recheck de RLS que o Realtime faz por trás falha com "permission denied" e
-- o servidor propaga um evento com `record: {}`, `columns: []` e
-- `errors: ["Error 401: Unauthorized"]` — em vez de simplesmente não entregar nada. Nenhum
-- dado real vaza (nenhuma coluna vem preenchida), mas quebra a garantia de "zero eventos"
-- para quem não tem acesso algum. Reproduzido e confirmado neste projeto antes de decidir
-- manter o GRANT SELECT de anon em messages/conversations (ver bloco 3 abaixo) — é esse
-- grant, combinado com ZERO policy de RLS para anon, que faz o Postgres devolver "0 linhas,
-- sem erro" para o recheck, e o Realtime volta a não entregar nada (mesmo comportamento já
-- provado no relatório original da Task 2, antes deste fix).

-- === 3) Fecha a Data API (PostgREST) para anon/authenticated em todas as tabelas, exceto
--        o SELECT pontual de messages/conversations (authenticated lê de verdade, filtrado
--        pela RLS; anon recebe só o SELECT — sem policy nenhuma para o role dela, então RLS
--        nega tudo por padrão — necessário para o Realtime devolver silêncio real em vez do
--        evento de erro vazio descrito acima) ===
-- Guardado por existência das roles anon/authenticated (não existem no droplet/CI — bloco
-- inteiro é no-op lá, mesmo padrão do resto do arquivo).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    -- Revoga TUDO (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) de anon em
    -- TODAS as tabelas hoje existentes no schema public...
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    -- ...e SÓ ENTÃO reabre o SELECT em messages/conversations — nunca INSERT/UPDATE/DELETE,
    -- e nenhuma outra tabela. anon não tem (e nunca terá) policy de RLS nessas duas
    -- tabelas: a ausência de policy nega TODAS as linhas por padrão com RLS habilitada, o
    -- que é o comportamento equivalente (zero dados) ao de authenticated ler filtrado pela
    -- policy — só que sem policy alguma para anon. Este grant é sobre o Realtime devolver
    -- silêncio real (nota acima) — não é uma concessão de acesso de fato.
    GRANT SELECT ON public.messages, public.conversations TO anon;
    -- Tabelas que ainda não existem (migrações futuras) também devem nascer fechadas para
    -- anon. ALTER DEFAULT PRIVILEGES sem "FOR ROLE" aplica ao role que EXECUTA este
    -- comando — nas migrações, sempre o dono das tabelas (postgres) — cancelando o default
    -- que o Supabase configura na criação do projeto (GRANT ALL a anon/authenticated FOR
    -- ROLE postgres IN SCHEMA public).
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Mesma revogação total para authenticated, e SÓ ENTÃO reabre exatamente o que o
    -- Realtime precisa: postgres_changes filtra a linha usando o mesmo mecanismo do
    -- PostgREST (a mudança é "lida" via SELECT sob o role/JWT do assinante para decidir se
    -- a policy libera aquela linha) — sem este GRANT SELECT, RLS nunca chega a ser
    -- avaliada porque a permissão de tabela já barra antes, e o resultado é ZERO eventos
    -- entregues, SEM NENHUM ERRO real de negócio no client (só o "Error 401" descrito
    -- acima, que também não é o comportamento desejado para quem TEM que enxergar a
    -- própria conversa). É o mesmo modo de falha silenciosa do Important corrigido no
    -- bloco 1 — por isso este comentário é redundante de propósito: este GRANT é
    -- load-bearing e não deve ser removido/esquecido numa limpeza futura de privilégios
    -- sem revalidar o Realtime.
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    GRANT SELECT ON public.messages, public.conversations TO authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END $$;
