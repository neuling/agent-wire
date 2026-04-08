import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { State } from '../src/daemon/state.js'
import { startServer, ServerHandle } from '../src/daemon/server.js'
import { DaemonClient } from '../src/bridge/daemonClient.js'

describe('DaemonClient', () => {
  let srv: ServerHandle
  let client: DaemonClient

  beforeAll(async () => {
    srv = await startServer(new State(), 4801)
    client = new DaemonClient('http://127.0.0.1:4801')
  })
  afterAll(async () => { await srv.close() })

  it('probe returns true when daemon is up', async () => {
    expect(await client.probe()).toBe(true)
  })

  it('probe returns false against a dead port', async () => {
    const dead = new DaemonClient('http://127.0.0.1:4802')
    expect(await dead.probe()).toBe(false)
  })

  it('call wire_register returns ok with agent_id', async () => {
    const res = await client.call('wire_register', { name: 'a', description: '', working_dir: '/tmp', context: {} }, { supports_push: true })
    expect(res.ok).toBe(true)
    expect(res.data.agent_id).toBeDefined()
  })

  it('call returns ok:false on tool error (still parses body)', async () => {
    const res = await client.call('wire_describe', { agent: 'nope' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no such agent/)
  })

  it('subscribeEvents receives a live event', async () => {
    const events: any[] = []
    const unsub = client.subscribeEvents(e => events.push(e))
    // give the SSE connection a moment to establish
    await new Promise(r => setTimeout(r, 100))
    await client.call('wire_register', { name: 'sub-test', description: '', working_dir: '/tmp', context: {} }, { supports_push: false })
    // wait for the event to arrive
    for (let i = 0; i < 20 && events.length === 0; i++) {
      await new Promise(r => setTimeout(r, 50))
    }
    unsub()
    expect(events.some(e => e.type === 'agent_joined' && e.agent?.name === 'sub-test')).toBe(true)
  })
})
