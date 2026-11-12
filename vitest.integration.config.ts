import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
