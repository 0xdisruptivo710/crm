-- AlterTable
-- `prisma migrate dev` recusa gerar esta migração automaticamente porque
-- `@default(uuid())` é um default de APLICAÇÃO (Prisma gera o valor antes do
-- insert) e a tabela já tem linhas — não há default de BANCO para popular
-- as existentes. Backfill manual: default de banco (gen_random_uuid(), nativo
-- desde o Postgres 13) só para preencher as linhas atuais, removido em
-- seguida — inserts futuros continuam recebendo o valor do Prisma Client,
-- como qualquer outra coluna do schema (ADR-0003).
ALTER TABLE "companies" ADD COLUMN "webhook_token" TEXT NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "companies" ALTER COLUMN "webhook_token" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "companies_webhook_token_key" ON "companies"("webhook_token");
