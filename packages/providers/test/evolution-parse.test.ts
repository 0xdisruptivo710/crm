import { join } from 'node:path'
import { createEvolutionProvider } from '../src/index.js'
import { runProviderContractSuite } from './contract-suite.js'

const provider = createEvolutionProvider({ baseUrl: 'https://exemplo.invalido', apiKey: 'x', instanceId: 'x' })
runProviderContractSuite(provider, join(import.meta.dirname, '..', '..', '..', 'tests', 'providers', 'fixtures', 'evolution'))
