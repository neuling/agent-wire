import { describe, it, expect, beforeEach } from 'vitest'
import { State } from '../src/daemon/state.js'
import { dispatchTool } from '../src/daemon/mcp.js'

describe('dispatchTool', () => {
  let s: State
  beforeEach(() => { s = new State() })

  it('wire_register returns agent_id and emits join', async () => {
    const res = await dispatchTool(s, {
      tool: 'wire_register',
      args: { name: 'a', working_dir: '/tmp', description: 'x', context: {} },
      supports_push: false,
    })
    expect(res.ok).toBe(true)
    expect(res.data.agent_id).toBeDefined()
    expect(res.data.name).toBe('a')
  })

  it('wire_list returns agents', async () => {
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    const res = await dispatchTool(s, { tool: 'wire_list', args: {} })
    expect(res.ok).toBe(true)
    expect(res.data.length).toBe(1)
    expect(res.data[0].name).toBe('a')
  })

  it('wire_status updates and piggybacks pending', async () => {
    const reg = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'b', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_send', args: { to: 'a', kind: 'note', body: 'hi', priority: 'normal' }, agent_name: 'b' })
    const res = await dispatchTool(s, { tool: 'wire_status', args: { agent_id: reg.data.agent_id, status: 'working' } })
    expect(res.pending?.length).toBe(1)
    expect(res.pending?.[0].body).toBe('hi')
  })

  it('wire_describe returns full card or error', async () => {
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: 'X', context: { claude_md_summary: 'sum' } }, supports_push: false })
    const ok = await dispatchTool(s, { tool: 'wire_describe', args: { agent: 'a' } })
    expect(ok.ok).toBe(true)
    expect(ok.data.context.claude_md_summary).toBe('sum')
    const miss = await dispatchTool(s, { tool: 'wire_describe', args: { agent: 'nope' } })
    expect(miss.ok).toBe(false)
  })

  it('wire_send requires caller agent_name', async () => {
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    const res = await dispatchTool(s, { tool: 'wire_send', args: { to: 'a', kind: 'note', body: 'hi', priority: 'normal' } })
    expect(res.ok).toBe(false)
  })

  it('wire_read returns pending and marks read', async () => {
    const a = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'b', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_send', args: { to: 'a', kind: 'note', body: 'hi', priority: 'normal' }, agent_name: 'b' })
    const res = await dispatchTool(s, { tool: 'wire_read', args: { agent_id: a.data.agent_id } })
    expect(res.data.length).toBe(1)
    const again = await dispatchTool(s, { tool: 'wire_read', args: { agent_id: a.data.agent_id } })
    expect(again.data.length).toBe(0)
  })

  it('wire_log + wire_log_read', async () => {
    const reg = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_log', args: { agent_id: reg.data.agent_id, entry: 'decision' } })
    const res = await dispatchTool(s, { tool: 'wire_log_read', args: {} })
    expect(res.data.length).toBe(1)
    expect(res.data[0].entry).toBe('decision')
    expect(res.data[0].agent).toBe('a')
  })

  it('wire_touch updates last_activity', async () => {
    const reg = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    const before = s.get('a')!.last_activity
    await new Promise(r => setTimeout(r, 5))
    const res = await dispatchTool(s, { tool: 'wire_touch', args: { agent_id: reg.data.agent_id } })
    expect(res.ok).toBe(true)
    expect(s.get('a')!.last_activity).not.toBe(before)
  })

  it('rejects unknown tool', async () => {
    const res = await dispatchTool(s, { tool: 'wire_bogus', args: {} } as any)
    expect(res.ok).toBe(false)
  })

  it('wire_deregister removes the agent and is idempotent', async () => {
    const reg = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    const r1 = await dispatchTool(s, { tool: 'wire_deregister', args: { agent_id: reg.data.agent_id } })
    expect(r1.ok).toBe(true)
    expect(s.get('a')).toBeUndefined()
    // second call is a no-op, still ok
    const r2 = await dispatchTool(s, { tool: 'wire_deregister', args: { agent_id: reg.data.agent_id } })
    expect(r2.ok).toBe(true)
  })

  it('piggybacks pending on wire_list when caller identity is known', async () => {
    const a = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'b', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_send', args: { to: 'a', kind: 'note', body: 'hi', priority: 'normal' }, agent_name: 'b' })
    const listRes = await dispatchTool(s, { tool: 'wire_list', args: {}, agent_id: a.data.agent_id })
    expect(listRes.pending?.length).toBe(1)
    expect(listRes.pending?.[0].body).toBe('hi')
  })

  it('piggybacks pending on wire_describe as well', async () => {
    const a = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'b', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_send', args: { to: 'a', kind: 'note', body: 'hi', priority: 'normal' }, agent_name: 'b' })
    const dres = await dispatchTool(s, { tool: 'wire_describe', args: { agent: 'b' }, agent_id: a.data.agent_id })
    expect(dres.pending?.length).toBe(1)
  })
})
