import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prismaUnsafe } from '../packages/db/src/testing.js'

// Sanitização OBRIGATÓRIA (spec §11 + adjudicação da Task 8): telefones e nomes reais
// trocados por valores sintéticos ESTÁVEIS (mesmo original → mesmo substituto,
// preservando correlações), mídia binária truncada, texto humano substituído por
// frase sintética de comprimento equivalente, segredos de infraestrutura removidos.
// Payload cru real NUNCA é commitado sem passar por aqui.
//
// EXTENSÕES sobre a versão-base do brief (documentadas no task-8-report.md):
//  1. Sufixo de JID ampliado para @lid além de @s.whatsapp.net/@g.us — a Evolution usa
//     o "LID" (identidade ligada) do WhatsApp em participantAlt/remoteJidAlt, e o range
//     de dígitos ampliado de {12,13} para {10,20} cobre também o JID de grupo (18
//     dígitos) e o próprio LID (13-15 dígitos observados).
//  2. Buffers binários (mediaKey, fileSha256, jpegThumbnail etc.) chegam do banco como
//     objeto JSON de índices numéricos ({"0":12,"1":98,...}), não como string base64 —
//     é assim que a Evolution/Baileys serializa Uint8Array. A regra "base64 > 500
//     chars" foi estendida para também truncar esses objetos quando têm mais de 256
//     entradas (jpegThumbnail real chega a ~2400 bytes — uma miniatura de foto real é
//     dado pessoal visual, não só "mídia grande"). Buffers pequenos (chaves/hashes de
//     32 bytes) ficam intactos: são ruído criptográfico opaco, não dado pessoal, e
//     preservam a forma real do payload para o parser da Task 9.
//  3. Conteúdo de texto humano (message.conversation, quotedMessage.conversation,
//     caption de mídia, hydratedContentText/hydratedTitleText de template) é
//     substituído por frase sintética em português do MESMO comprimento — conversas
//     reais são dado pessoal, não só nomes/telefones.
//  4. Query params de autenticação do CDN do WhatsApp (ccb, oh, oe, _nc_sid, _nc_cat,
//     mms3) são removidos de qualquer URL/directPath, preservando host e path.
//  5. Segredos de infraestrutura própria (nunca mencionados na spec, mas óbvios ao
//     inspecionar o payload real): apikey e instanceId da Evolution são UUIDs — um
//     scrub genérico de qualquer substring em formato UUID neutraliza os dois sem
//     precisar de lista de campos. O campo `destination` (URL de callback do nosso
//     próprio webhook) e `server_url` (host da nossa instância dev) têm o host
//     trocado por um domínio fictício — o token da company embutido no path de
//     `destination` já cai no scrub de UUID genérico. `instance` (nome curto da
//     instância, ex. "aios-pocket") também é trocado por um valor fixo — não é dado
//     de cliente, mas não custa nada não commitar o nome real do ambiente de dev.
//  6. fileName/title de documentMessage viram um nome genérico preservando a extensão.

const phoneMap = new Map<string, string>()
let phoneSeq = 0
function syntheticPhone(real: string): string {
  const existing = phoneMap.get(real)
  if (existing) return existing
  phoneSeq += 1
  const synthetic = `5511${String(999990000 + phoneSeq)}`
  phoneMap.set(real, synthetic)
  return synthetic
}

const nameMap = new Map<string, string>()
let nameSeq = 0
function syntheticName(real: string): string {
  const existing = nameMap.get(real)
  if (existing) return existing
  nameSeq += 1
  const synthetic = nameSeq === 1 ? 'Cliente Teste' : `Cliente Teste ${nameSeq}`
  nameMap.set(real, synthetic)
  return synthetic
}

// Banco de palavras neutras em português — nunca deriva do conteúdo real, só do
// COMPRIMENTO dele, então não há risco de vazar fragmento de conversa real.
const FILLER_WORDS = [
  'atendimento', 'confirmar', 'horario', 'disponivel', 'obrigado', 'equipe', 'proposta',
  'documento', 'retorno', 'processo', 'pedido', 'entrega', 'pagamento', 'endereco', 'reuniao',
  'seguimos', 'aguardo', 'revisar', 'conversa', 'assunto', 'detalhe', 'combinado', 'positivo',
  'agenda', 'cliente', 'suporte', 'duvida', 'produto', 'anexo', 'contrato', 'valor', 'consulta',
]
let textSeq = 0
function syntheticText(real: string): string {
  if (real.length === 0) return real
  let out = ''
  let i = textSeq % FILLER_WORDS.length
  textSeq += 7 // avança bastante entre chamadas para variar o texto gerado
  while (out.length < real.length) {
    out += (out.length > 0 ? ' ' : '') + FILLER_WORDS[i % FILLER_WORDS.length]
    i += 1
  }
  return out.slice(0, real.length)
}

function genericFileName(real: string): string {
  const ext = /\.[a-zA-Z0-9]{2,5}$/.exec(real)?.[0] ?? ''
  return `documento-teste${ext}`
}
function genericTitle(real: string): string {
  const ext = /\.[a-zA-Z0-9]{2,5}$/.exec(real)?.[0] ?? ''
  return `Documento Teste${ext}`
}

// Detecta objeto JSON que é, na prática, um Uint8Array serializado (chaves "0","1",...
// sequenciais com valores 0-255) — forma como a Evolution manda buffers binários.
function isByteArrayObject(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(([k, v], i) => k === String(i) && typeof v === 'number' && v >= 0 && v <= 255)
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const CDN_AUTH_PARAM_RE = /([?&](?:ccb|oh|oe|_nc_sid|_nc_cat|mms3)=)[^&]*/g
const PHONE_JID_RE = /\d{10,20}(?=@s\.whatsapp\.net|@g\.us|@lid)/g
const WHOLE_STRING_BASE64_RE = /^[A-Za-z0-9+/=]{500,}$/

function sanitizeString(value: string): string {
  let out = value.replace(PHONE_JID_RE, (m) => syntheticPhone(m))
  out = out.replace(WHOLE_STRING_BASE64_RE, '[BASE64_REMOVIDO]')
  out = out.replace(CDN_AUTH_PARAM_RE, (_m, prefix: string) => `${prefix}x`)
  out = out.replace(UUID_RE, '00000000-0000-0000-0000-000000000000')
  return out
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value)
  if (isByteArrayObject(value) && Object.keys(value).length > 256) return '[BASE64_REMOVIDO]'
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]): [string, unknown] => {
      if ((k === 'pushName' || k === 'profileName' || k === 'verifiedName') && typeof v === 'string') {
        return [k, syntheticName(v)]
      }
      if ((k === 'conversation' || k === 'caption' || k === 'hydratedContentText' || k === 'hydratedTitleText') && typeof v === 'string') {
        return [k, syntheticText(v)]
      }
      if (k === 'fileName' && typeof v === 'string' && v.length > 0) return [k, genericFileName(v)]
      if (k === 'title' && typeof v === 'string' && v.length > 0) return [k, genericTitle(v)]
      if (k === 'destination' && typeof v === 'string') {
        return [k, sanitizeString(v.replace(/^https?:\/\/[^/]+/, 'https://fixture.invalido'))]
      }
      if (k === 'server_url' && typeof v === 'string') {
        return [k, sanitizeString(v.replace(/^https?:\/\/[^/]+/, 'https://evolution.exemplo.invalido'))]
      }
      if (k === 'instance' && typeof v === 'string') return [k, 'aios-pocket-fixture']
      return [k, sanitize(v)]
    })
    return Object.fromEntries(entries)
  }
  return value
}

// ---------------------------------------------------------------------------------
// Classificação + seleção de representantes (adjudicação da Task 8): TODAS as
// categorias distintas entram; categorias de alto volume (texto, fromMe, acks, reply)
// entram só com 2-3 representantes espalhados no tempo. sanity.check é excluído.
// incoming_edit NÃO existe — Evolution 2.3.7 não entrega esse evento (ver README).
// ---------------------------------------------------------------------------------

type Kind =
  | 'incoming_text'
  | 'incoming_from_me'
  | 'incoming_audio'
  | 'incoming_image'
  | 'incoming_document'
  | 'incoming_reply'
  | 'incoming_reaction'
  | 'incoming_special'
  | 'status_update'
  | 'connection_update'
  | 'send_message_echo'

type RawEvent = Awaited<ReturnType<typeof prismaUnsafe.rawWebhookEvent.findMany>>[number]

interface Classified {
  event: RawEvent
  kind: Kind
  sub?: string
}

function classify(payload: Record<string, unknown>): { kind: Kind; sub?: string } | null {
  const event = payload.event
  if (event === 'connection.update') return { kind: 'connection_update' }
  if (event === 'messages.update') {
    const data = (payload.data ?? {}) as Record<string, unknown>
    return { kind: 'status_update', sub: String(data.status ?? 'unknown') }
  }
  if (event === 'send.message') return { kind: 'send_message_echo' }
  if (event === 'messages.upsert') {
    const data = (payload.data ?? {}) as Record<string, unknown>
    const key = (data.key ?? {}) as Record<string, unknown>
    const message = (data.message ?? {}) as Record<string, unknown>
    const contextInfo = data.contextInfo as Record<string, unknown> | undefined
    const fromMe = key.fromMe === true
    const isReply = Boolean(contextInfo?.stanzaId)
    if (message.reactionMessage) return { kind: 'incoming_reaction' }
    if (message.secretEncryptedMessage) return { kind: 'incoming_special', sub: 'secretEncrypted' }
    if (message.templateMessage) return { kind: 'incoming_special', sub: 'template' }
    if (isReply) return { kind: 'incoming_reply' }
    if (message.audioMessage) return { kind: 'incoming_audio' }
    if (message.imageMessage) return { kind: 'incoming_image' }
    if (message.documentMessage) return { kind: 'incoming_document' }
    if (fromMe) return { kind: 'incoming_from_me' }
    if (message.conversation !== undefined) return { kind: 'incoming_text' }
    return null // ex.: mensagem de grupo só com senderKeyDistributionMessage — sem conteúdo visível
  }
  return null // sanity.check e qualquer evento desconhecido ficam fora das fixtures
}

// Domain.md: o CRM modela conversa 1:1 (Customer↔Conversation) — grupo do WhatsApp
// não é cliente e o parser da Task 9 deve descartá-lo (nota de review da Task 3).
// Por isso as categorias com volume suficiente preferem SEMPRE amostra de chat
// individual; só cai para grupo quando não existe nenhuma alternativa individual
// (ex.: o único reactionMessage capturado aconteceu num grupo de teste).
function isGroupJid(payload: Record<string, unknown>): boolean {
  const data = (payload.data ?? {}) as Record<string, unknown>
  const key = (data.key ?? {}) as Record<string, unknown>
  const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : ''
  return remoteJid.endsWith('@g.us')
}
function preferIndividual(list: Classified[]): Classified[] {
  const individual = list.filter((c) => !isGroupJid(c.event.payload as Record<string, unknown>))
  return individual.length > 0 ? individual : list
}

// Amostra n itens espalhados uniformemente ao longo da lista (preserva ordem
// cronológica), em vez de pegar sempre os n primeiros — dá mais variedade real.
function pickSpread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  if (n <= 1) return items[0] === undefined ? [] : [items[0]]
  const picked: T[] = []
  const seen = new Set<number>()
  for (let i = 0; i < n; i += 1) {
    const idx = Math.round((i * (items.length - 1)) / (n - 1))
    if (!seen.has(idx)) {
      seen.add(idx)
      const item = items[idx]
      if (item !== undefined) picked.push(item)
    }
  }
  return picked
}

async function main(): Promise<void> {
  const events = await prismaUnsafe.rawWebhookEvent.findMany({
    where: { provider: 'evolution' },
    orderBy: { receivedAt: 'asc' },
  })

  const classified: Classified[] = []
  for (const ev of events) {
    const result = classify(ev.payload as Record<string, unknown>)
    if (result) classified.push({ event: ev, kind: result.kind, sub: result.sub })
  }

  const byKind = new Map<Kind, Classified[]>()
  for (const c of classified) {
    const list = byKind.get(c.kind) ?? []
    list.push(c)
    byKind.set(c.kind, list)
  }

  const selected: Classified[] = []

  // Categorias raras: todas as amostras entram (não há volume para cortar).
  const ALL_KINDS: Kind[] = ['incoming_audio', 'incoming_image', 'incoming_document', 'incoming_reaction', 'connection_update', 'send_message_echo']
  for (const kind of ALL_KINDS) selected.push(...(byKind.get(kind) ?? []))

  // Categorias de alto volume: 2-3 representantes espalhados no tempo, priorizando
  // chat individual (ver preferIndividual acima).
  selected.push(...pickSpread(preferIndividual(byKind.get('incoming_text') ?? []), 3))
  selected.push(...pickSpread(preferIndividual(byKind.get('incoming_from_me') ?? []), 3))
  selected.push(...pickSpread(preferIndividual(byKind.get('incoming_reply') ?? []), 3))

  // status_update: 1 representante por valor de status distinto observado (ex.:
  // DELIVERY_ACK, READ, SERVER_ACK) — mais útil que 3 aleatórios do mesmo valor.
  const statusGroups = new Map<string, Classified[]>()
  for (const c of byKind.get('status_update') ?? []) {
    const list = statusGroups.get(c.sub ?? 'unknown') ?? []
    list.push(c)
    statusGroups.set(c.sub ?? 'unknown', list)
  }
  for (const list of statusGroups.values()) {
    const first = list[0]
    if (first) selected.push(first)
  }

  // incoming_special: 1 representante por sub-tipo (secretEncrypted e template),
  // também priorizando chat individual dentro de cada sub-tipo.
  const specialGroups = new Map<string, Classified[]>()
  for (const c of byKind.get('incoming_special') ?? []) {
    const list = specialGroups.get(c.sub ?? 'unknown') ?? []
    list.push(c)
    specialGroups.set(c.sub ?? 'unknown', list)
  }
  for (const list of specialGroups.values()) {
    const first = preferIndividual(list)[0]
    if (first) selected.push(first)
  }

  selected.sort((a, b) => a.event.receivedAt.getTime() - b.event.receivedAt.getTime())

  const dir = join(process.cwd(), 'tests', 'providers', 'fixtures', 'evolution')
  mkdirSync(dir, { recursive: true })
  // Idempotência: reruns não deixam fixture órfã de uma seleção anterior.
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) unlinkSync(join(dir, f))

  const perKindCounter = new Map<Kind, number>()
  const manifest: Array<{ file: string; kind: Kind }> = []
  for (const c of selected) {
    const n = (perKindCounter.get(c.kind) ?? 0) + 1
    perKindCounter.set(c.kind, n)
    const file = `${c.kind}-${n}.json`
    writeFileSync(join(dir, file), `${JSON.stringify(sanitize(c.event.payload), null, 2)}\n`)
    manifest.push({ file, kind: c.kind })
  }
  manifest.sort((a, b) => a.file.localeCompare(b.file))
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const summary = new Map<Kind, number>()
  for (const c of selected) summary.set(c.kind, (summary.get(c.kind) ?? 0) + 1)
  console.log(`${selected.length} fixtures escritas em ${dir}`)
  console.log(`(${classified.length} eventos classificados de ${events.length} eventos totais no banco — sanity.check e eventos irrelevantes excluídos)`)
  console.log('Distribuição:', Object.fromEntries(summary))
}

main().finally(() => prismaUnsafe.$disconnect())
