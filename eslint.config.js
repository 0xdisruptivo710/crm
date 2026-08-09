import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Arquivos de teste, usados em mais de um bloco abaixo (evita duplicar o glob).
const TEST_GLOBS = ['**/test/**', '**/*.test.ts', '**/*.test.tsx']

const PRISMA_PATH = {
  name: '@prisma/client',
  message: 'Prisma só em packages/db (ADR-0001). Use os repositories de @aios-pocket/db.',
}
const DB_TESTING_PATH = {
  name: '@aios-pocket/db/testing',
  message: 'USO EXCLUSIVO EM TESTES — importe @aios-pocket/db/testing apenas em arquivos de teste.',
}

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.js', '!eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  // ATENÇÃO: no flat config do ESLint, quando dois blocos casam com o mesmo arquivo e
  // definem a MESMA regra (ex.: 'no-restricted-imports'), o bloco posterior SUBSTITUI
  // por inteiro a config do anterior — não faz merge dos arrays `paths`. Por isso as
  // duas restrições de import abaixo (Prisma fora de packages/db; @aios-pocket/db/testing
  // fora de arquivos de teste) são combinadas em blocos por "quadrante" (dentro/fora de
  // packages/db × dentro/fora de teste), cada um definindo 'no-restricted-imports' uma
  // única vez, com exatamente os `paths` que se aplicam àquele quadrante. Verificado
  // empiricamente com `eslint --print-config`.
  {
    // Fora de packages/db, fora de teste: proíbe Prisma direto E @aios-pocket/db/testing.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/db/**', ...TEST_GLOBS],
    rules: {
      'no-restricted-imports': ['error', { paths: [PRISMA_PATH, DB_TESTING_PATH] }],
    },
  },
  {
    // Fora de packages/db, em teste: Prisma direto continua proibido; /testing é permitido.
    files: TEST_GLOBS,
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [PRISMA_PATH] }],
    },
  },
  {
    // Dentro de packages/db, fora de teste: Prisma direto é permitido (é o próprio pacote);
    // @aios-pocket/db/testing continua proibido fora de teste.
    files: ['packages/db/**/*.ts', 'packages/db/**/*.tsx'],
    ignores: TEST_GLOBS,
    rules: {
      'no-restricted-imports': ['error', { paths: [DB_TESTING_PATH] }],
    },
  },
  // Dentro de packages/db E em teste: ambos permitidos — nenhum bloco necessário.
  {
    // Hosts de provider só em packages/providers (ADR-0002)
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/providers/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/aios-evolution|z-api\\u002eio/]',
          message: 'Chamada direta a provider fora de packages/providers viola a arquitetura (ADR-0002).',
        },
      ],
    },
  },
)
