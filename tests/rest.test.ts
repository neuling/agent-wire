import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { State } from '../src/daemon/state.js'
import { startServer, ServerHandle } from '../src/daemon/server.js'

let portCounter = 4500

describe('HTTP server', () => {
  let state: State
  let srv: ServerHandle
  let base: string

  beforeEach(async () => {
    state = new State()
    srv = await startServer(state, portCounter++)
    base = `http://127.0.0.1:${srv.port}`
  })
  afterEach(async () => { await srv.close() })

  it('POST /mcp wire_register then GET /api/agents', async () => {
    const reg = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'wire_register', args: { name: 'a', description: '', working_dir: '/tmp', context: {} }, supports_push: false }),
    })
    expect(reg.status).toBe(200)
    const agents = await (await fetch(`${base}/api/agents`)).json()
    expect(agents.length).toBe(1)
    expect(agents[0].name).toBe('a')
  })

  it('GET /api/agents/:name returns one or 404', async () => {
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'wire_register', args: { name: 'a', description: '', working_dir: '/tmp', context: {} }, supports_push: false }),
    })
    const ok = await fetch(`${base}/api/agents/a`)
    expect(ok.status).toBe(200)
    const miss = await fetch(`${base}/api/agents/nope`)
    expect(miss.status).toBe(404)
  })

  it('GET /api/events streams SSE with initial connect line and live event', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    const first = await reader.read()
    expect(dec.decode(first.value)).toContain(': connected')

    // trigger an event
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'wire_register', args: { name: 'x', description: '', working_dir: '/tmp', context: {} }, supports_push: false }),
    })

    // read until we see the agent_joined event
    let seen = ''
    for (let i = 0; i < 10; i++) {
      const next = await reader.read()
      if (next.value) seen += dec.decode(next.value)
      if (seen.includes('agent_joined')) break
    }
    expect(seen).toContain('agent_joined')
    ctrl.abort()
  })

  it('GET / serves the dashboard html', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const txt = await res.text()
    expect(txt).toContain('agent-wire')
  })

  it('GET /api/log returns []  initially', async () => {
    const res = await fetch(`${base}/api/log`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('unknown route 404', async () => {
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })
})
