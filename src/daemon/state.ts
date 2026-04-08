import { randomUUID } from 'node:crypto'
import { EventBus } from './events.js'
import { Agent, AgentContext, LogEntry, WireItem, WireItemKind, WireItemPriority } from './types.js'

interface RegisterInput {
  name: string
  description: string
  working_dir: string
  supports_push: boolean
  context: AgentContext
}

interface SendInput {
  from: string
  to: string
  kind: WireItemKind
  priority: WireItemPriority
  body: string
}

export class State {
  readonly bus = new EventBus()
  private agents = new Map<string, Agent>()
  private inbox = new Map<string, WireItem[]>()
  private log: LogEntry[] = []
  private _lastLogTs = ''

  private nextLogTimestamp(): string {
    let ts = new Date().toISOString()
    if (ts <= this._lastLogTs) {
      // Bump by 1ms to guarantee strict monotonicity
      ts = new Date(new Date(this._lastLogTs).getTime() + 1).toISOString()
    }
    this._lastLogTs = ts
    return ts
  }

  register(input: RegisterInput): { agent: Agent } {
    const name = this.uniqueName(input.name)
    const now = new Date().toISOString()
    const agent: Agent = {
      id: randomUUID(),
      name,
      description: input.description,
      working_dir: input.working_dir,
      status: '',
      connected_since: now,
      last_activity: now,
      supports_push: input.supports_push,
      context: input.context,
    }
    this.agents.set(name, agent)
    this.inbox.set(name, [])
    this.bus.emit({ type: 'agent_joined', agent })
    return { agent }
  }

  private uniqueName(base: string): string {
    if (!this.agents.has(base)) return base
    let i = 2
    while (this.agents.has(`${base}-${i}`)) i++
    return `${base}-${i}`
  }

  get(name: string): Agent | undefined { return this.agents.get(name) }
  list(): Agent[] { return [...this.agents.values()] }

  setStatus(agentId: string, status: string) {
    const agent = [...this.agents.values()].find(a => a.id === agentId)
    if (!agent) throw new Error(`unknown agent_id: ${agentId}`)
    agent.status = status
    agent.last_activity = new Date().toISOString()
    this.bus.emit({ type: 'status_changed', name: agent.name, status })
  }

  touch(agentId: string) {
    const agent = [...this.agents.values()].find(a => a.id === agentId)
    if (agent) agent.last_activity = new Date().toISOString()
  }

  send(input: SendInput): WireItem {
    const item: WireItem = {
      id: randomUUID(),
      from: input.from,
      to: input.to,
      kind: input.kind,
      priority: input.priority,
      body: input.body,
      timestamp: new Date().toISOString(),
      read: false,
      delivered_push: false,
    }
    const recipients = input.to === '*'
      ? [...this.agents.keys()].filter(n => n !== input.from)
      : [input.to]
    for (const r of recipients) {
      const box = this.inbox.get(r)
      if (box) box.push({ ...item })
    }
    this.bus.emit({ type: 'item_sent', item })
    return item
  }

  readPending(name: string): WireItem[] {
    const box = this.inbox.get(name) ?? []
    const unread = box.filter(i => !i.read)
    for (const i of unread) i.read = true
    if (unread.length > 0) {
      this.bus.emit({ type: 'item_read', name, ids: unread.map(i => i.id) })
    }
    return unread
  }

  peekPending(name: string): WireItem[] {
    return (this.inbox.get(name) ?? []).filter(i => !i.read)
  }

  appendLog(input: { agent: string; entry: string }): LogEntry {
    const entry: LogEntry = {
      id: randomUUID(),
      agent: input.agent,
      entry: input.entry,
      timestamp: this.nextLogTimestamp(),
    }
    this.log.push(entry)
    this.bus.emit({ type: 'log_appended', entry })
    return entry
  }

  readLog(since?: string): LogEntry[] {
    if (!since) return [...this.log]
    return this.log.filter(e => e.timestamp > since)
  }

  deregister(name: string) {
    if (!this.agents.has(name)) return
    this.agents.delete(name)
    this.inbox.delete(name)
    this.bus.emit({ type: 'agent_left', name })
  }
}
