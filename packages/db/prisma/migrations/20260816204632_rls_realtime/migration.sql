-- Task 2 (Plano C): Supabase pronto para ser o banco vivo — RLS read-only e publication
-- do Realtime em messages/conversations.
--
-- Exceção ÚNICA do ADR-0001/0005: RLS não é o mecanismo de tenancy do produto (ADR-0001)
-- — o isolamento por company_id continua enforced pela aplicação via TenantContext e
-- repositories (packages/db); a API acessa o Postgres como o usuário "postgres" (dono das
-- tabelas), que ignora RLS por padrão. Estas políticas existem só para o Supabase Realtime
-- poder filtrar o que o browser autenticado recebe via postgres_changes — o Realtime não
-- conhece TenantContext, então o filtro tem que morrer no próprio Postgres.

-- ENABLE ROW LEVEL SECURITY é incondicional: inofensivo em qualquer Postgres (droplet de
-- teste/CI incluído). Sem nenhuma policy, RLS habilitado só afeta roles que não sejam a
-- dona da tabela — a API ("postgres") continua enxergando tudo normalmente.
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;

-- As policies dependem de auth.uid() e da role "authenticated", ambos exclusivos do
-- Supabase — o Postgres do droplet (test/CI) não tem o schema "auth" nem essa role. A
-- guarda abaixo torna este bloco no-op nesses ambientes e efetivo só no Supabase, sem
-- precisar de um arquivo de migração separado por ambiente. Também é idempotente
-- (checagem em pg_policies antes do CREATE POLICY) porque CREATE POLICY não aceita
-- IF NOT EXISTS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'realtime_read_messages'
    ) THEN
      CREATE POLICY "realtime_read_messages" ON "public"."messages" FOR SELECT TO authenticated
        USING (company_id IN (SELECT company_id FROM users WHERE auth_user_id = auth.uid()));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'conversations' AND policyname = 'realtime_read_conversations'
    ) THEN
      CREATE POLICY "realtime_read_conversations" ON "public"."conversations" FOR SELECT TO authenticated
        USING (company_id IN (SELECT company_id FROM users WHERE auth_user_id = auth.uid()));
    END IF;

  END IF;
END $$;

-- Publication do Supabase Realtime ("supabase_realtime"): também exclusiva do Supabase — o
-- Postgres do droplet/CI não a cria. Guardada por existência da publication e idempotente
-- via checagem em pg_publication_tables antes do ADD TABLE (ALTER PUBLICATION ... ADD TABLE
-- não aceita IF NOT EXISTS e falha com duplicate_object se a tabela já estiver assinada).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
    ) THEN
      ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."messages";
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversations'
    ) THEN
      ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."conversations";
    END IF;

  END IF;
END $$;
