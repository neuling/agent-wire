#!/usr/bin/env node
import { State } from './state.js'
import { startServer } from './server.js'

const PORT = Number(process.env.AGENT_WIRE_PORT ?? 4747)

async function main() {
  const state = new State()
  const srv = await startServer(state, PORT)
  console.error(`[agent-wire] daemon on http://127.0.0.1:${srv.port}`)

  const reaper = setInterval(() => {
    const reaped = state.reapStale()
    if (reaped.length > 0) {
      console.error(`[agent-wire] reaped stale agents: ${reaped.join(', ')}`)
    }
  }, 15_000)
  reaper.unref?.()

  const cleanup = async () => {
    clearInterval(reaper)
    await srv.close()
  }
  process.on('SIGINT',  async () => { await cleanup(); process.exit(0) })
  process.on('SIGTERM', async () => { await cleanup(); process.exit(0) })
}

main().catch(e => { console.error(e); process.exit(1) })
