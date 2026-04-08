import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { State } from '../src/daemon/state.js'
import { startServer, ServerHandle } from '../src/daemon/server.js'
import { DaemonClient } from '../src/bridge/daemonClient.js'

describe('e2e', () => {
  let srv: ServerHandle
  let client: DaemonClient

  beforeAll(async () => {
    srv = await startServer(new State(), 4899)
    client = new DaemonClient('http://127.0.0.1:4899')
  })
  afterAll(async () => { await srv.close() })

  it('two agents register, exchange an item, and see it via piggyback', async () => {
    const a = await client.call('wire_register', {
      name: 'alice', description: 'UI', working_dir: '/tmp', context: {},
    }, { supports_push: true })
    const b = await client.call('wire_register', {
      name: 'bob', description: 'API', working_dir: '/tmp', context: {},
    }, { supports_push: false })
    expect(a.ok && b.ok).toBe(true)

    // bob sends a note to alice
    const sent = await client.call('wire_send', {
      to: 'alice', kind: 'note', body: 'hello alice', priority: 'normal',
    }, { agent_name: 'bob' })
    expect(sent.ok).toBe(true)

    // alice calls wire_status — should receive the pending item piggybacked
    const status = await client.call('wire_status', {
      agent_id: a.data.agent_id, status: 'working',
    })
    expect(status.ok).toBe(true)
    expect(status.pending).toBeDefined()
    expect(status.pending!.length).toBe(1)
    expect(status.pending![0].body).toBe('hello alice')
    expect(status.pending![0].from).toBe('bob')
    expect(status.pending![0].kind).toBe('note')

    // reading again should return no pending (already consumed)
    const second = await client.call('wire_status', {
      agent_id: a.data.agent_id, status: 'still working',
    })
    expect(second.pending?.length ?? 0).toBe(0)
  })

  it('broadcast reaches all agents except sender', async () => {
    const c = await client.call('wire_register', {
      name: 'carol', description: '', working_dir: '/tmp', context: {},
    }, { supports_push: true })
    expect(c.ok).toBe(true)

    await client.call('wire_send', {
      to: '*', kind: 'note', body: 'hello everyone', priority: 'normal',
    }, { agent_name: 'carol' })

    // fetch current list to get IDs
    const list = await client.call('wire_list', {})
    const alice = list.data.find((x: any) => x.name === 'alice')
    const bob = list.data.find((x: any) => x.name === 'bob')
    const carol = list.data.find((x: any) => x.name === 'carol')

    const aliceRead = await client.call('wire_read', { agent_id: alice.agent_id })
    const bobRead = await client.call('wire_read', { agent_id: bob.agent_id })
    const carolRead = await client.call('wire_read', { agent_id: carol.agent_id })

    expect(aliceRead.data.some((i: any) => i.body === 'hello everyone')).toBe(true)
    expect(bobRead.data.some((i: any) => i.body === 'hello everyone')).toBe(true)
    expect(carolRead.data.some((i: any) => i.body === 'hello everyone')).toBe(false)
  })

  it('SSE subscriber receives item_sent events (the channel-pump path)', async () => {
    const events: any[] = []
    const unsub = client.subscribeEvents(e => events.push(e))
    // allow the stream to connect
    await new Promise(r => setTimeout(r, 100))

    const dave = await client.call('wire_register', {
      name: 'dave', description: '', working_dir: '/tmp', context: {},
    }, { supports_push: true })
    expect(dave.ok).toBe(true)

    await client.call('wire_send', {
      to: 'alice', kind: 'request', body: 'please look at X', priority: 'high',
    }, { agent_name: 'dave' })

    // poll briefly for the event
    for (let i = 0; i < 30 && !events.some(e => e.type === 'item_sent'); i++) {
      await new Promise(r => setTimeout(r, 25))
    }
    unsub()

    const itemSent = events.find(e => e.type === 'item_sent')
    expect(itemSent).toBeDefined()
    expect(itemSent.item.body).toBe('please look at X')
    expect(itemSent.item.from).toBe('dave')
    expect(itemSent.item.to).toBe('alice')
    expect(itemSent.item.priority).toBe('high')
  })

  it('wire_describe returns the full agent card', async () => {
    // alice is registered with empty context, so describe returns her basic card
    const described = await client.call('wire_describe', { agent: 'alice' })
    expect(described.ok).toBe(true)
    expect(described.data.name).toBe('alice')
    expect(described.data.description).toBe('UI')
    expect(described.data.working_dir).toBe('/tmp')
  })

  it('log append + read', async () => {
    const list = await client.call('wire_list', {})
    const alice = list.data.find((x: any) => x.name === 'alice')

    await client.call('wire_log', {
      agent_id: alice.agent_id, entry: 'decision: use tRPC for internal APIs',
    })

    const read = await client.call('wire_log_read', {})
    expect(read.ok).toBe(true)
    expect(read.data.some((e: any) => e.entry.includes('tRPC'))).toBe(true)
  })
})
