import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'Use pure WallClock primitives in src/domain instead of global Date.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"]',
          message:
            'Use pure WallClock primitives in src/domain instead of new Date().',
        },
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: 'Use injected Clock in src/domain instead of Date.now().',
        },
        {
          selector:
            'MemberExpression[object.name="Math"][property.name=/^(random|round|floor|ceil|trunc)$/]',
          message:
            'Floating-point operations and non-deterministic Math functions (random, round, floor, ceil, trunc) are forbidden on money in src/domain. Use integer paisa helpers with an explicit documented eslint-disable if justified.',
        },
        {
          selector: 'CallExpression[callee.name="parseFloat"]',
          message:
            'Floating-point parsing (parseFloat) is forbidden in src/domain. Money is integer paisa only.',
        },
        {
          selector: 'CallExpression[callee.property.name="toFixed"]',
          message:
            'Number.prototype.toFixed is forbidden in src/domain. Money is integer paisa only.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'path',
                'http',
                'https',
                'crypto',
                'os',
                'child_process',
              ],
              message:
                'src/domain must be pure and dependency-free. Node standard libraries are forbidden.',
            },
            {
              group: [
                'express',
                'prisma',
                '@prisma/*',
                'firebase*',
                'zod',
                'vitest',
              ],
              message:
                'src/domain must be pure and dependency-free. External packages are forbidden.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'test/vectors/**'],
  },
);
