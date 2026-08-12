-- Task 4 (Plano C): chave de idempotência do envio. A UI (T7) sempre gera clientMessageId
-- via crypto.randomUUID() em POST /messages; a rota grava esse valor em Message e usa a
-- unique abaixo para detectar retry/duplo-clique (P2002 → readback, padrão prisma-errors —
-- devolve o messageId ORIGINAL em vez de criar uma segunda linha).
--
-- Migração puramente aditiva: coluna NULLABLE (mensagens inbound do webhook nunca a
-- preenchem) + unique composta com company_id. NÃO precisa de backfill nas linhas
-- existentes — todas têm client_message_id NULL hoje, e o Postgres trata cada NULL como
-- distinto dentro de um índice único (nenhuma colisão entre linhas antigas).

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "client_message_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "messages_company_id_client_message_id_key" ON "messages"("company_id", "client_message_id");
