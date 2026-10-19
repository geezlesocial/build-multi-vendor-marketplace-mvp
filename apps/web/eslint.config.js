import tsParser from '@typescript-eslint/parser';
export default [{ ignores: ['dist/**'] }, { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } } }];
