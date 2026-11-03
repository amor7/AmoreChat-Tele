// Catches real mistakes (undefined names, unused code, unreachable code), not style.
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off', // used on purpose to strip control characters from input
};

export default [
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['server/**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules,
  },
  {
    // Test scripts also run code inside the browser page (puppeteer evaluate).
    files: ['server/test/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['web/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': hooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
    },
    settings: { react: { version: '19' } },
    rules: { ...rules, 'react/jsx-uses-vars': 'error', 'react/jsx-uses-react': 'error', 'react/jsx-key': 'error', 'react/jsx-no-undef': 'error', 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'off' },
  },
];
