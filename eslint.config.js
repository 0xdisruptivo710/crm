import js from '@eslint/js'
import tseslint from 'typescript-eslint'

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
    // Prisma só em packages/db (ADR-0001)
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@prisma/client', message: 'Prisma só em packages/db (ADR-0001). Use os repositories de @aios-pocket/db.' }] },
      ],
    },
  },
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
