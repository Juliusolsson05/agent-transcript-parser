import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['testing/**/*.live.test.ts'],
    fileParallelism: false,
  },
})
