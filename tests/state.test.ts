import { describe, it, expect, beforeEach } from 'vitest'
import { State } from '../src/daemon/state.js'

describe('State', () => {
  let s: State
  beforeEach(() => { s = new State() })

  it('registers an agent and emits agent_joined', () => {
    const events: any[] = []
    s.bus.subscribe(e => events.push(e))
    const { agent } = s.register({ name: 'frontend', description: 'UI', working_dir: '/tmp', supports_push: true, context: {} })
    expect(agent.name).toBe('frontend')
    expect(events[0].type).toBe('agent_joined')
  })

  it('auto-suffixes colliding names', () => {
    s.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    const { agent } = s.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    expect(agent.name).toBe('a-2')
  })

  it('lists agents', () => {
    s.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    s.register({ name: 'b', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    expect(s.list().map(x => x.name).sort()).toEqual(['a', 'b'])
  })

  it('updates status and emits', () => {
    const { agent } = s.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    const events: any[] = []
    s.bus.subscribe(e => events.push(e))
    s.setStatus(agent.id, 'working on X')
    expect(s.get('a')?.status).toBe('working on X')
    expect(events[0]).toMatchObject({ type: 'status_changed', name: 'a', status: 'working on X' })
  })

  it('sends item to a specific agent and returns pending on read', () => {
    s.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    s.register({ name: 'b', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    s.send({ from: 'a', to: 'b', kind: 'note', priority: 'normal', body: 'hi' })
    const pending = s.readPending('b')
    expect(pending.map(x => x.body)).toEqual(['hi'])
    expect(s.readPending('b')).toEqual([])
  })

  it('broadcast (*) delivers to all except sender', () => {
    s.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    s.register({ name: 'b', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    s.register({ name: 'c', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    s.send({ from: 'a', to: '*', kind: 'note', priority: 'normal', body: 'hey' })
    expect(s.readPending('a')).toEqual([])
    expect(s.readPending('b').length).toBe(1)
    expect(s.readPending('c').length).toBe(1)
  })

  it('appends and reads log with optional since filter', () => {
    s.appendLog({ agent: 'a', entry: 'first' })
    s.appendLog({ agent: 'a', entry: 'second' })
    const all = s.readLog()
    expect(all.length).toBe(2)
    const since = s.readLog(all[0].timestamp)
    expect(since.length).toBe(1)
  })

  it('deregister removes the agent and emits agent_left', () => {
    s.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    const events: any[] = []
    s.bus.subscribe(e => events.push(e))
    s.deregister('a')
    expect(s.get('a')).toBeUndefined()
    expect(events[0].type).toBe('agent_left')
  })

  it('reapStale drops agents whose last_activity is older than the threshold', async () => {
    const s2 = new State()
    s2.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    s2.register({ name: 'b', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    // force a's last_activity into the past
    const agent = s2.get('a')!
    ;(agent as any).last_activity = new Date(Date.now() - 60_000).toISOString()
    const reaped = s2.reapStale(30_000)
    expect(reaped).toEqual(['a'])
    expect(s2.get('a')).toBeUndefined()
    expect(s2.get('b')).toBeDefined()
  })

  it('getById finds an agent by uuid', () => {
    const s2 = new State()
    const { agent } = s2.register({ name: 'a', description: '', working_dir: '/tmp', supports_push: false, context: {} })
    expect(s2.getById(agent.id)?.name).toBe('a')
    expect(s2.getById('nope')).toBeUndefined()
  })
})
