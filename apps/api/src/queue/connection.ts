import IORedis from 'ioredis'
import { config } from '../config.js'

// Duas conexões com papéis diferentes (mesma Redis, mesma URL):
//
// - Worker: usa comandos bloqueantes internos do BullMQ (BRPOPLPUSH/BLMOVE) que
//   não podem expirar por retry — maxRetriesPerRequest: null é exigência do
//   BullMQ para esse caso.
// - Producers (Queue.add chamado a partir de rota HTTP): o oposto. Se a Redis
//   cair, o comando NÃO pode tentar para sempre — a rota HTTP nunca espera
//   infra (regra do CLAUDE.md, seção 4; ADR-0004). Falhar rápido aqui é
//   intencional: melhor a rota devolver 5xx do que travar esperando retry.
export const redisWorkerConnection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null })
redisWorkerConnection.on('error', (err) => {
  console.error('[redis worker] erro de conexão', err.message)
})

// enableOfflineQueue: false faz .add() rejeitar na hora quando desconectado,
// em vez de acumular comandos em memória à espera de reconexão (o que também
// prenderia a requisição HTTP chamadora).
export const redisQueueConnection = new IORedis(config.REDIS_URL, { enableOfflineQueue: false })
redisQueueConnection.on('error', (err) => {
  console.error('[redis queue] erro de conexão', err.message)
})
