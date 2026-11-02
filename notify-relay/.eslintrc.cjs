// Keep Worker lint independent of the app and its React Native plugins.
module.exports = {
  root: true,
  env: { node: true, es2022: true, jest: true },
  ignorePatterns: [ 'worker-configuration.d.ts', 'coverage/', '.wrangler/', '.cloudflare/' ],
  overrides: [
    {
      files: [ '**/*.ts' ],
      extends: [
        'plugin:@typescript-eslint/strict-type-checked',
        'plugin:@typescript-eslint/stylistic-type-checked',
        'plugin:sonarjs/recommended-legacy'
      ],
      parser: '@typescript-eslint/parser',
      parserOptions: { project: './tsconfig.test.json', tsconfigRootDir: __dirname },
      rules: {
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': [ 'error', { checksVoidReturn: { attributes: false } } ],
        '@typescript-eslint/no-unnecessary-condition': 'off',
        '@typescript-eslint/no-unnecessary-type-assertion': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        '@typescript-eslint/prefer-nullish-coalescing': 'off',
        '@typescript-eslint/prefer-optional-chain': 'error',
        '@typescript-eslint/require-await': 'error',
        '@typescript-eslint/restrict-template-expressions': [
          'error',
          {
            allow: [ { name: [ 'Error', 'URL', 'URLSearchParams' ], from: 'lib' } ],
            allowAny: false,
            allowArray: false,
            allowBoolean: true,
            allowNever: true,
            allowNullish: true,
            allowNumber: true,
            allowRegExp: true
          }
        ],
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/array-type': 'off',
        '@typescript-eslint/consistent-type-definitions': 'off',
        '@typescript-eslint/no-confusing-void-expression': 'off',
        '@typescript-eslint/no-deprecated': 'off',
        '@typescript-eslint/no-dynamic-delete': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/non-nullable-type-assertion-style': 'off',
        '@typescript-eslint/prefer-includes': 'off',
        '@typescript-eslint/prefer-regexp-exec': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
        'no-void': [ 'error', { allowAsStatement: true } ],
        'sonarjs/cognitive-complexity': 'off',
        'sonarjs/deprecation': 'off',
        'sonarjs/different-types-comparison': 'off',
        'sonarjs/no-alphabetical-sort': 'off',
        'sonarjs/no-all-duplicated-branches': 'error',
        'sonarjs/no-clear-text-protocols': 'off',
        'sonarjs/no-collapsible-if': 'error',
        'sonarjs/no-control-regex': 'off',
        'sonarjs/no-duplicated-branches': 'error',
        'sonarjs/no-hardcoded-ip': 'off',
        'sonarjs/no-hardcoded-passwords': 'off',
        'sonarjs/no-identical-functions': 'error',
        'sonarjs/no-invariant-returns': 'off',
        'sonarjs/no-selector-parameter': 'off',
        'sonarjs/no-nested-conditional': 'off',
        'sonarjs/no-nested-functions': 'off',
        'sonarjs/no-nested-template-literals': 'off',
        'sonarjs/prefer-regexp-exec': 'off',
        'sonarjs/prefer-read-only-props': 'off',
        'sonarjs/publicly-writable-directories': 'off',
        'sonarjs/super-linear-regex': 'off',
        'sonarjs/single-char-in-character-classes': 'off',
        'sonarjs/updated-loop-counter': 'off',
        'sonarjs/synchronous-suite-callback': 'off'
      }
    },
    {
      files: [ '__tests__/**/*.ts' ],
      rules: {
        '@typescript-eslint/no-deprecated': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/unbound-method': 'off',
        '@typescript-eslint/only-throw-error': 'off',
        'sonarjs/code-eval': 'off',
        'sonarjs/no-unused-collection': 'off'
      }
    }
  ],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
        message: 'Use an explicit background-operation, cleanup, cancellation, or settlement helper.'
      },
      {
        selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
        message: 'Use an explicit background-operation, cleanup, cancellation, or settlement helper.'
      }
    ]
  }
};
