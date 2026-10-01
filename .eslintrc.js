const wireContractImports = {
  group: ['**/generated/**', '**/*herdrApiBridge*'],
  message: 'Keep generated wire contracts behind application services.',
};

module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      extends: [
        'plugin:@typescript-eslint/strict-type-checked',
        'plugin:@typescript-eslint/stylistic-type-checked',
        'plugin:sonarjs/recommended-legacy',
        'plugin:react-hooks/recommended-latest',
      ],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
      rules: {
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': [
          'error',
          { checksVoidReturn: { attributes: false } },
        ],
        // Runtime/native values routinely need checks that their declaration
        // types claim are redundant. Keep validation rather than erase it.
        '@typescript-eslint/no-unnecessary-condition': 'off',
        '@typescript-eslint/no-unnecessary-type-assertion': 'error',
        '@typescript-eslint/no-unsafe-argument': 'error',
        '@typescript-eslint/no-unsafe-assignment': 'error',
        '@typescript-eslint/no-unsafe-call': 'error',
        '@typescript-eslint/no-unsafe-member-access': 'error',
        '@typescript-eslint/no-unsafe-return': 'error',
        // Whip deliberately collapses empty strings and zero-like UI values in
        // many normalization paths; ?? would change those semantics. The rule
        // produced 84 such findings even with primitive types ignored.
        '@typescript-eslint/prefer-nullish-coalescing': 'off',
        '@typescript-eslint/prefer-optional-chain': 'error',
        '@typescript-eslint/require-await': 'error',
        '@typescript-eslint/restrict-template-expressions': [
          'error',
          {
            allow: [
              { name: ['Error', 'URL', 'URLSearchParams'], from: 'lib' },
            ],
            allowAny: false,
            allowArray: false,
            allowBoolean: true,
            allowNever: true,
            allowNullish: true,
            allowNumber: true,
            allowRegExp: true,
          },
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
        // Metro uses require() for statically bundled image and font assets.
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
        'no-void': ['error', { allowAsStatement: true }],
        'react-hooks/exhaustive-deps': 'error',
        // These React Compiler rules misclassify React Native Animated,
        // Reanimated worklets, async data-loading effects, and latest-ref hooks.
        'react-hooks/immutability': 'off',
        'react-hooks/preserve-manual-memoization': 'off',
        'react-hooks/purity': 'off',
        'react-hooks/refs': 'off',
        'react-hooks/set-state-in-effect': 'off',
        // The initial threshold flagged 28 established protocol/UI functions
        // (complexity 21-263). Do not force broad legacy refactors or cosmetic
        // helper extraction as part of this hardening pass.
        'sonarjs/cognitive-complexity': 'off',
        'sonarjs/deprecation': 'off',
        // SonarJS 4.2 reports equality between Whip's string IDs as comparing
        // different types under TypeScript 6.
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
        // Selector parameters are useful for small state toggles, and invariant
        // return values are valid for Promise-based interface adapters.
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
        // Parser cursors legitimately advance over variable-width tokens.
        'sonarjs/updated-loop-counter': 'off',
        // SonarJS 4.2 calls the ESLint 9 SourceCode#getRange API despite
        // declaring ESLint 8 compatibility, which crashes legacy-config lint.
        'sonarjs/synchronous-suite-callback': 'off',
      },
    },
    {
      files: ['App.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'react-native-whip-ssh',
                message: 'Use application services instead of native transport in the composition root.',
              },
            ],
            patterns: [
              wireContractImports,
              {
                group: ['**/services/HerdrClient*'],
                message: 'Use application hooks instead of HerdrClient in the composition root.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/components/**/*.ts', 'src/components/**/*.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          { patterns: [wireContractImports] },
        ],
      },
    },
    {
      files: [
        'src/components/PaneDetail.tsx',
        'src/components/HerdScreen.tsx',
        'src/components/SessionScreen.tsx',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [wireContractImports],
            paths: [
              {
                name: 'react-native',
                importNames: ['Alert'],
                message: 'Use app-styled errors instead of the native Alert API.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['__tests__/**/*.ts', '__tests__/**/*.tsx'],
      rules: {
        // Jest mocks and matchers intentionally expose dynamic call surfaces;
        // production code remains covered by all unsafe-value rules.
        '@typescript-eslint/no-deprecated': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/unbound-method': 'off',
        // Test harnesses intentionally capture hook output outside React and
        // exercise native/Promise failures that reject with non-Error values.
        '@typescript-eslint/only-throw-error': 'off',
        'react-hooks/globals': 'off',
        'sonarjs/code-eval': 'off',
        'sonarjs/no-unused-collection': 'off',
      },
    },
  ],
  rules: {
    // Dynamic theme and safe-area values are intentionally supplied inline.
    'react-native/no-inline-styles': 'off',
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']",
        message: 'Use an explicit background-operation, cleanup, cancellation, or settlement helper.',
      },
      {
        selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
        message: 'Use an explicit background-operation, cleanup, cancellation, or settlement helper.',
      },
    ],
  },
};
