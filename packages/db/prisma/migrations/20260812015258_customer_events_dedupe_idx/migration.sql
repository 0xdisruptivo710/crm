-- Hardening batch C, Step 3 (TOCTOU do timeline condicional, achado da review do Plano B):
-- process-webhook.ts/send-message.ts gravam a timeline com um padrão "findFirst depois
-- create" (idempotência condicional) — entre a leitura e a escrita existe uma janela onde
-- duas execuções concorrentes do MESMO correlationId/type (retry sobreposto, dois workers
-- pegando o mesmo raw reenfileirado) podem, em teoria, passar pelo findFirst juntas e
-- duplicar a linha. Este índice fecha a janela no BANCO, não só no código — a aplicação
-- ganha um catch de P2002 tratando a colisão como no-op (mesmo padrão já usado para o
-- dedupe de Message, ver prisma-errors.ts).
--
-- Verificado manualmente contra o banco VIVO antes de aplicar esta migração (task-1-report.md,
-- Plano C): 0 grupos duplicados nos 470 registros existentes nos 3 tipos cobertos. O DELETE
-- abaixo fica mesmo assim, defensivo/idempotente (0 linhas removidas quando não há
-- duplicata) — protege qualquer ambiente que não tenha sido checado manualmente (CI, banco
-- novo) de uma CREATE UNIQUE INDEX falhando no meio do deploy. Mantém a linha mais antiga
-- (created_at, desempate por id) e descarta as demais.
DELETE FROM "customer_events" a
USING "customer_events" b
WHERE a."company_id" = b."company_id"
  AND a."customer_id" = b."customer_id"
  AND a."type" = b."type"
  AND a."correlation_id" = b."correlation_id"
  AND a."type" IN ('message_received', 'message_sent', 'message_sent_from_phone')
  AND (a."created_at" > b."created_at" OR (a."created_at" = b."created_at" AND a."id" > b."id"));

-- CreateIndex
-- Índice único PARCIAL — Prisma não representa índices parciais no schema.prisma (sem
-- suporte a cláusula WHERE em @@index/@@unique); esta migração é raw SQL de propósito,
-- sem alteração correspondente em schema.prisma (mesmo padrão que a Task 2 do Plano C vai
-- usar para as políticas RLS do Realtime). Transições de status (message_status_changed,
-- message_send_failed) ficam FORA do índice de propósito: o MESMO correlationId repete
-- legitimamente entre estados distintos de uma mesma Message (sent→delivered→read não são
-- duplicata uma da outra) — só os tipos "ponto de origem" da timeline (uma linha por
-- Message) entram na unicidade.
CREATE UNIQUE INDEX "customer_events_dedupe_idx" ON "customer_events"("company_id", "customer_id", "type", "correlation_id") WHERE "type" IN ('message_received', 'message_sent', 'message_sent_from_phone');
