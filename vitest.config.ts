import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // WHY this must be root-level: Vitest 4 decides whether a selected project
    // has no files before applying that project's nested options. Core and
    // system are intentionally empty today because parser verification belongs
    // to the corpus tier, but their standardized commands must still work.
    passWithNoTests: true,
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
