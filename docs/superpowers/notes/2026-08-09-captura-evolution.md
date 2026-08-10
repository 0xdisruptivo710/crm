# Captura ao vivo de payloads reais — Evolution dev (2026-08-09)

Registro da Task 7 do Plano B: túnel + roteiro de captura com o usuário, matéria-prima das fixtures reais (Task 8) e da suíte de contrato de provider (Task 9).

## Infra da captura

- API local (`pnpm --filter @aios-pocket/api dev`) exposta via túnel `cloudflared tunnel --url http://localhost:3001`.
- Um watchdog simples reiniciava o túnel/API quando a conexão caía durante a sessão de captura (sessões longas de WhatsApp real são instáveis por natureza — reconexões de rede, sono do notebook, etc.).
- Webhook da instância Evolution **dev** (`aios-pocket`, nunca a `murilo` de produção) apontado para a URL pública do túnel, `POST /webhooks/evolution/<webhookToken>` (Task 6).
- **Ambos — túnel cloudflared e watchdog — foram aposentados no deploy** (Task 12): a API deployada no EasyPanel tem URL pública estável própria; o túnel era só uma ponte temporária para a fase de captura local.

## Resultado da captura

**77 eventos reais** arquivados em `raw_webhook_events` durante a sessão, cobrindo o roteiro dos 9 itens do Task 7 (texto, fromMe, áudio, imagem, documento, reply, edição, acks de envio, conexão). Categorias observadas (algumas se sobrepõem — ex.: uma mensagem `fromMe` com mídia é contada tanto em "fromMe" quanto na categoria de mídia correspondente):

| Categoria | Quantidade |
|---|---|
| Texto (inbound) | 16 |
| fromMe (resposta digitada no celular do piloto) | 12 + 1 |
| Áudio (inbound) | 2 |
| Imagem (inbound, com/sem legenda) | 2 + 1 |
| Documento/PDF (inbound) | 1 |
| Reply/quote | 5 |
| Reação (em grupo) | 1 |
| Acks de envio (sent/delivered/read) | 34 |
| Conexão (`CONNECTION_UPDATE`, logout/reconnect) | 2 |
| Eco de envio via API (`sendText`) | 1 |
| `secretEncrypted` (payload não decodificável pela versão instalada) | 3 |
| Template | 1 |

Total: 77 eventos crus, superando a meta de >= 15 eventos do roteiro da Task 7.

## Achado

**A Evolution 2.3.7 não emite eventos de edição de mensagem.** Testado com **2 tentativas controladas** (editar uma mensagem já enviada, no celular do piloto, aguardando `MESSAGES_UPDATE` ou qualquer webhook equivalente) — nenhum evento de edição chegou em nenhuma das duas tentativas. Consequência direta: a categoria `incoming_edit` do manifesto de fixtures (Task 8/9) não pôde ser populada com um payload real da Evolution nesta versão; registrado como item de verificação futura para o Z-API no intake do Plano D (`docs/superpowers/2026-08-08-plano-a-carryover.md`).

## Sanitização

Todo payload cru capturado passou pelo pipeline de sanitização (`scripts/harvest-fixtures.ts`, Task 8) antes de qualquer commit — telefones e nomes reais substituídos por valores sintéticos estáveis, mídia base64 truncada. Nenhum dado real do piloto ou de terceiros foi commitado nas fixtures.
