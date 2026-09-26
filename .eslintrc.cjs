/**
 * 渐进式防线：存量代码只在被改动时接受检查（配合 lint-staged）。
 * error 级 = 会挡提交的正确性红线；风格与存量顽疾降为 warn，碰到即清、不堵路。
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true
  },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:vue/vue3-recommended',
    'prettier'
  ],
  rules: {
    // TS 项目关闭 no-undef：类型名（EventListener 等）由 tsc 校验，eslint 会误报
    'no-undef': 'off',
    'no-constant-condition': ['error', { checkLoops: false }],
    // ---- 红线（error，挡提交）----
    'no-debugger': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    // 静默吞错是屎山三禁之一：catch 里至少要留痕或明确标注
    'no-empty': ['error', { allowEmptyCatch: false }],
    'no-console': ['error', { allow: ['warn', 'error', 'info', 'log'] }],

    // ---- 存量顽疾（warn，碰到即清）----
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'vue/multi-word-component-names': 'off',
    'vue/no-v-html': 'warn',
    // 模板细节风格交给 prettier/后续批次，不在此阻塞
    'vue/max-attributes-per-line': 'off',
    'vue/singleline-html-element-content-newline': 'off',
    'vue/html-self-closing': 'off',
    'vue/html-indent': 'off',
    'vue/attributes-order': 'off',
    'vue/first-attr-linebreak': 'off',
    'vue/html-closing-bracket-newline': 'off'
  },
  ignorePatterns: [
    'dist',
    'node_modules',
    'src-tauri/target',
    'auto-imports.d.ts',
    'components.d.ts',
    '*.d.ts',
    'scripts'
  ]
}
