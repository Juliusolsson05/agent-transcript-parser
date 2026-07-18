import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/**/*.test.ts', 'testing/**/*.test.ts'],
          exclude: [
            'testing/**/*.corpus.test.ts',
            'testing/**/*.system.test.ts',
            'testing/**/*.live.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'system',
          environment: 'node',
          include: ['testing/**/*.system.test.ts'],
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'corpus',
          environment: 'node',
          include: ['testing/**/*.corpus.test.ts'],
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // WHY these mirror the measured full-source baseline: corpus coverage is
      // now an enforced floor rather than a report that CI computes and throws
      // away. New semantic cases should ratchet the relevant dimension upward.
      thresholds: { statements: 41, branches: 30, functions: 46, lines: 43 },
    },
  },
})
