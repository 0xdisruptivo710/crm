import { buildApp } from './app.js'
import { config } from './config.js'
import { startDomainEventsWorker } from './queue/workers.js'

const app = buildApp()

// Um único deployable: API + workers no mesmo processo (stack inegociável).
startDomainEventsWorker()

app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
