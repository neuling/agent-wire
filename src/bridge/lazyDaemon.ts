import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { DaemonClient } from './daemonClient.js'

/**
 * Ensure a daemon is running and reachable. If not, fork the daemon bin
 * as a detached background process and wait up to 3s for it to come up.
 *
 * Resolves the daemon entry point relative to this file:
 *   dev (tsx, src/bridge/lazyDaemon.ts) → ../daemon/index.ts
 *   built (dist/bridge/lazyDaemon.js)   → ../daemon/index.js
 */
export async function ensureDaemon(): Promise<void> {
  const client = new DaemonClient()
  if (await client.probe()) return

  const daemonBin = locateDaemonBin()

  const isTs = daemonBin.endsWith('.ts')
  const cmd = process.execPath
  const args = isTs
    ? ['--import', 'tsx', daemonBin]
    : [daemonBin]

  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  child.unref()

  // poll until reachable or 3s deadline
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (await client.probe()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`agent-wire daemon failed to start within 3s (tried ${daemonBin})`)
}

function locateDaemonBin(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../daemon/index.js'),
    resolve(here, '../daemon/index.ts'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('cannot find agent-wire daemon entry point')
}
