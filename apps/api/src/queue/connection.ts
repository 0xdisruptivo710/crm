import IORedis from 'ioredis'
import { config } from '../config.js'

// maxRetriesPerRequest: null é exigência do BullMQ para conexões de worker.
export const redisConnection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null })
