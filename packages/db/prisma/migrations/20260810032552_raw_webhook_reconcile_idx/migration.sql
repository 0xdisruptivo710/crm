-- CreateIndex
CREATE INDEX "raw_webhook_events_processed_received_at_idx" ON "raw_webhook_events"("processed", "received_at");
