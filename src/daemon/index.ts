#!/usr/bin/env node
import { State } from './state.js'
import { startServer } from './server.js'

const PORT = Number(process.env.AGENT_WIRE_PORT ?? 4040)

async function main() {
  const state = new State()
  const srv = await startServer(state, PORT)
  console.error(`[agent-wire] daemon on http://127.0.0.1:${srv.port}`)
  process.on('SIGINT',  async () => { await srv.close(); process.exit(0) })
  process.on('SIGTERM', async () => { await srv.close(); process.exit(0) })
}

main().catch(e => { console.error(e); process.exit(1) })
