import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

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
  {
    // react-hooks só se aplica a apps/web (única app React do monorepo). Reintroduzido na
    // Task 7 do Plano C (revisão da T6, requisito Important): a remoção do
    // eslint-config-next ficou correta, mas sem ele nada pega stale closures em
    // hooks/effects — risco real no Inbox (handlers de dados + polling em
    // conversation-list/conversation-view/instance-badge). Só as duas regras pedidas —
    // NÃO o preset `recommended-latest` inteiro do plugin (que hoje inclui regras extras
    // voltadas ao React Compiler, fora do escopo deste ajuste).
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
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
        {
          // A regra acima só enxerga `Literal` (string simples): 'https://z-api.io'.
          // URLs de provider em código real costumam vir em template literals, ex.:
          // `${baseUrl}/z-api.io/...` ou `https://z-api.io/${path}` — que o parser
          // representa como TemplateElement, não Literal. Sem este segundo seletor,
          // a regra fica cega para o caso mais comum na prática.
          selector: 'TemplateElement[value.raw=/aios-evolution|z-api\\u002eio/]',
          message: 'Chamada direta a provider fora de packages/providers viola a arquitetura (ADR-0002).',
        },
      ],
    },
  },
)
