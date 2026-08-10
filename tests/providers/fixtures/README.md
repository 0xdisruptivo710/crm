# Fixtures de webhook — patrimônio técnico (Conventions.md)

`tests/providers/fixtures/{evolution,zapi}/` guarda payloads **reais** de webhook,
sanitizados, capturados em produção/dev. Regra sem exceção (Conventions.md §3.10):

> Todo bug de provider descoberto em produção vira fixture; toda fixture vira teste.

Nunca escrevemos um payload sintético "inventado" quando existe (ou pode existir) um
payload real equivalente. A suíte de contrato (`packages/providers/test/contract-suite.ts`,
Task 9) roda sobre estas fixtures via `manifest.json` — é a mesma bateria que qualquer
provider novo (Z-API no Plano D) precisa passar.

## `evolution/`

23 fixtures reais, capturadas ao vivo da instância Evolution de dev (`aios-pocket`,
2.3.7) durante a Task 7 do Plano B, e sanitizadas pela Task 8 antes do commit
(`pnpm fixtures:harvest`, ver `scripts/harvest-fixtures.ts` na raiz).

### Como foram escolhidas

Do total de eventos reais capturados no banco (`raw_webhook_events`, provider
`evolution`), o evento `sanity.check` (POST de smoke-test da Task 7, sem forma de
webhook real) foi excluído. Os demais foram classificados pela forma real do payload
(chave da mensagem: `conversation`, `imageMessage`, `audioMessage`, `documentMessage`,
`reactionMessage`, `secretEncryptedMessage`/`templateMessage`, `contextInfo.stanzaId`
para reply, `fromMe`) e agrupados em `kind`. Categorias raras (áudio, imagem,
documento, reação, connection.update, send.message) entraram por inteiro. Categorias
de alto volume (texto, fromMe, acks) entraram com 2-3 representantes espalhados no
tempo — não faz sentido commitar 34 acks quase idênticos quando 3 já cobrem os valores
distintos de `status` (`DELIVERY_ACK`, `READ`, `SERVER_ACK`).

Mensagens de **grupo do WhatsApp** (`remoteJid` terminado em `@g.us`) foram
deliberadamente evitadas nas categorias com alternativa de chat individual — o CRM
modela conversa 1:1 (Domain.md; nota de review da Task 3: "parser DEVE filtrar
mensagens de grupo antes de resolver customer"), então uma fixture de "texto normal"
deveria refletir o caso comum, não a exceção. A única fixture de grupo que sobrou é
`incoming_reaction-1.json`, porque foi a única reação capturada e não existe
alternativa individual — o parser da Task 9 ainda precisa lidar com ela (nem que seja
para descartar por ser de grupo).

### `manifest.json`

Lista `{ file, kind }` para cada fixture. Valores de `kind` em uso:

| kind | significado |
|---|---|
| `incoming_text` | mensagem de texto simples (`conversation`), recebida |
| `incoming_from_me` | mensagem enviada pelo humano no celular, ecoada pelo webhook (`fromMe: true`) — **precisa** virar mensagem outbound na conversa, nunca ser tratada como inbound |
| `incoming_audio` | `audioMessage` (nota de voz) |
| `incoming_image` | `imageMessage`, com e sem `caption` |
| `incoming_document` | `documentMessage` |
| `incoming_reply` | mensagem com `contextInfo.stanzaId`/`quotedMessage` (resposta a outra mensagem) |
| `incoming_reaction` | `reactionMessage` (emoji de reação a uma mensagem) |
| `incoming_special` | `secretEncryptedMessage` ou `templateMessage` — tipos que o parser não decodifica em detalhe, mas não pode explodir ao receber |
| `status_update` | `messages.update` (ack de entrega/leitura) |
| `connection_update` | `connection.update` (instância conectando/aberta/caída) |
| `send_message_echo` | `send.message` (eco do envio feito pela própria API, via `EvolutionProvider.sendText`) |

### ⚠️ `incoming_edit` NÃO EXISTE — e isso é proposital

A Evolution 2.3.7 **não entrega evento de edição via webhook** (verificado ao vivo em
2026-08-09, duas tentativas controladas: mensagem editada no celular, zero webhook
recebido em qualquer formato reconhecível). Isto é uma adjudicação do controller do
Plano B, não um esquecimento — **não fabrique uma fixture `incoming_edit` sintética**.

O suporte a edição **permanece no contrato** interno (`IncomingMessage.isEdit` em
`packages/contracts`, ADR-0003) porque outro provider pode entregá-lo — a Z-API será
testada especificamente para isso no Plano D. Se esse dia chegar e a Z-API confirmar
o evento, a fixture real dela entra em `tests/providers/fixtures/zapi/` e o teste de
contrato ganha o caso de novo, agora com payload real.

### Sanitização

Nenhum payload aqui é cru. Todo dado real passa por `scripts/harvest-fixtures.ts`
antes de virar arquivo:

- **Telefones/JIDs** (`remoteJid`, `participant`, `participantAlt`, `remoteJidAlt`,
  `sender`, `wuid`, em qualquer profundidade) → número sintético estável na faixa
  `5511999990NNN` (mesmo número real sempre vira o mesmo sintético, preservando
  correlação entre fixtures — ex.: o mesmo contato de teste aparece com o mesmo
  número sintético em `incoming_text` e em `incoming_reply`).
- **Nomes** (`pushName`, `profileName`, `verifiedName`) → `Cliente Teste`,
  `Cliente Teste 2`, `Cliente Teste 3`... (estável por nome real).
- **Texto de conversa real** (`conversation`, `caption`, `quotedMessage.conversation`,
  `hydratedContentText`, `hydratedTitleText`) → frase sintética em português do MESMO
  comprimento — conversa real de cliente é dado pessoal, não só nome/telefone.
- **Mídia binária** (`jpegThumbnail`, e qualquer buffer serializado como objeto de
  índices numéricos com mais de 256 bytes) → `"[BASE64_REMOVIDO]"`. Buffers pequenos
  (chaves/hashes de 32 bytes) ficam intactos — são ruído criptográfico opaco, não dado
  pessoal, e mantêm a forma real do payload para o parser.
- **Nome de arquivo/título de documento** → nome genérico preservando a extensão
  (`documento-teste.pdf`).
- **URLs de mídia do CDN do WhatsApp** (`mmg.whatsapp.net`, `pps.whatsapp.net`) →
  mantêm host e path, mas os parâmetros de autenticação (`ccb`, `oh`, `oe`, `_nc_sid`,
  `_nc_cat`, `mms3`) são zerados.
- **Segredos de infraestrutura própria** (`apikey`, `instanceId`, o token de company
  embutido em `destination`) → qualquer substring em formato UUID vira
  `00000000-0000-0000-0000-000000000000`. `destination`/`server_url` têm o host
  trocado por um domínio fictício. `instance` vira `aios-pocket-fixture`.

Ver comentários no topo de `scripts/harvest-fixtures.ts` para o detalhe de cada regra
e o porquê de cada extensão sobre a especificação original.

### Regenerar

```
pnpm fixtures:harvest
```

Lê `raw_webhook_events` (provider `evolution`) do banco apontado por `DATABASE_URL`,
reclassifica, sanitiza e **reescreve** `tests/providers/fixtures/evolution/*.json` e
`manifest.json` do zero (remove fixtures antigas do diretório antes de escrever as
novas — reprodutível, sem lixo de execuções anteriores). Rodar de novo só é necessário
se: (a) uma nova categoria de bug precisar de fixture própria, ou (b) a seleção de
representantes precisar mudar. **Sempre revise o diff antes de commitar** — a suíte de
contrato falha alto (categoria obrigatória sem fixture), mas não existe automação que
substitua olhar o payload sanitizado com os próprios olhos.
