import { defineConfig } from 'vitest/config';
import { analysisCoreAlias } from './analysis-alias';

export default defineConfig({
  resolve: {
    alias: {
      '@swal/analysis-core': analysisCoreAlias(),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
