import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli/**'],
      // Thresholds enforced once services are implemented
      // thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
