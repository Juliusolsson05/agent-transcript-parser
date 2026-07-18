import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)

async function runVerification(script: string): Promise<string> {
  const { stdout } = await execute(
    process.execPath,
    ['--import', 'tsx', script],
    {
      cwd: process.cwd(),
      env: {
        // WHY the corpus subprocess receives a deliberately small, explicit
        // environment: the legacy verification programs predate Vitest and
        // run at module scope. Keeping them behind a process boundary lets
        // each domain fail independently without allowing a stray
        // process.exit() to terminate the test runner.
        PATH: process.env.PATH,
        NODE_NO_WARNINGS: '1',
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  return stdout
}

describe('checked-in transcript corpus', () => {
  it('passes the full compatibility battery', async () => {
    await expect(runVerification('testing/verify.ts')).resolves.toContain('All checks passed')
  })
})
