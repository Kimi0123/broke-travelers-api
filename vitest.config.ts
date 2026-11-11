import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/domain/**/*.test.ts', 'test/unit/**/*.test.ts'],
  },
});
