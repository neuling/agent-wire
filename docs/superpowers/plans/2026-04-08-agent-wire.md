# agent-wire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `agent-wire`, a local-only MCP server + stdio bridge + dashboard that lets multiple coding agents on the same machine see each other and pass notes, questions, and requests — with push delivery into Claude Code sessions via Channels.

**Architecture:** Single npm package with two bins. `agent-wire` = Node HTTP daemon on `127.0.0.1:4040` holding in-memory state and serving MCP (`POST /mcp`), REST+SSE for the dashboard (`GET /api/*`), and the SPA (`GET /`). `agent-wire-bridge` = per-session stdio MCP subprocess that (a) lazy-starts the daemon, (b) declares the Claude Code `claude/channel` capability, (c) proxies `wire_*` tool calls to the daemon over loopback HTTP, (d) pipes daemon SSE events into `notifications/claude/channel`, (e) auto-fills `repo`/`manifest` on register, (f) heartbeats every 10s. Dashboard is a single HTML file with vanilla JS + SSE.

**Tech Stack:** Node 20+, TypeScript, `@modelcontextprotocol/sdk`, `zod`, Node built-in `http`/`fs`/`child_process`. Test runner: `vitest`. Package manager: `pnpm`. No build tooling for the dashboard — single HTML file served as-is.

---

## File Structure

```
agent-wire/
├── package.json                 # name, bins, deps, scripts
├── tsconfig.json
├── vitest.config.ts
├── README.md                    # install + usage (written last)
├── .gitignore
├── src/
│   ├── daemon/
│   │   ├── index.ts             # bin entry: parses args, starts HTTP server
│   │   ├── server.ts            # HTTP server wiring (routes → handlers)
│   │   ├── state.ts             # in-memory state: agents, items, log (Map-based)
│   │   ├── events.ts            # EventBus for SSE fan-out (per-agent push queues + dashboard stream)
│   │   ├── mcp.ts               # POST /mcp handler, dispatches wire_* tools
│   │   ├── rest.ts              # GET /api/* handlers (agents, log, SSE /events)
│   │   ├── dashboard.ts         # GET / → serves embedded dashboard HTML
│   │   └── types.ts             # Agent, WireItem, LogEntry, WireEvent
│   ├── bridge/
│   │   ├── index.ts             # bin entry: lazy-start daemon, connect stdio MCP
│   │   ├── lazyDaemon.ts        # pidfile + probe + fork detached if needed
│   │   ├── daemonClient.ts      # HTTP client for loopback calls to daemon
│   │   ├── projectSniff.ts      # auto-fills repo + manifest from working_dir
│   │   └── channel.ts           # SSE subscribe, emit notifications/claude/channel
│   ├── dashboard/
│   │   └── index.html           # SPA (vanilla JS, SSE consumer)
│   └── shared/
│       └── schemas.ts           # zod schemas for all wire_* tool inputs
└── tests/
    ├── state.test.ts
    ├── mcp.test.ts              # integration: POST /mcp against a live daemon
    ├── rest.test.ts
    ├── projectSniff.test.ts
    ├── lazyDaemon.test.ts
    └── e2e.test.ts              # two bridge clients talk through a real daemon
```

**Design notes:**
- `state.ts` is the single source of truth. Every mutation goes through it and emits a `WireEvent` on the event bus. MCP handlers, REST handlers, and SSE subscribers are all pure consumers of state + events.
- `events.ts` has two fan-outs: (1) per-agent queues for push delivery to bridges (so only the target agent's bridge sees a `note`/`request`/`question`), (2) a global dashboard stream for every event.
- The dashboard HTML is embedded into the daemon bundle at build time via a `readFileSync` at startup (no separate static serving).
- `projectSniff.ts` is pure + sync-ish — reads `package.json`/`Gemfile`/etc and runs `git` via `child_process.execSync`. Fully unit-testable with fixtures.

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/schemas.ts` (empty stub), `src/daemon/types.ts`

- [ ] **Step 1: `git init` and first commit**

```bash
cd /Users/moritz/Playground/agent-mesh
git init
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "agent-wire",
  "version": "0.1.0",
  "description": "Private local bus for coding agents. See each other, pass notes, questions, requests — with push into Claude Code via Channels.",
  "type": "module",
  "bin": {
    "agent-wire": "./dist/daemon/index.js",
    "agent-wire-bridge": "./dist/bridge/index.js"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev:daemon": "tsx src/daemon/index.ts",
    "dev:bridge": "tsx src/bridge/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 10_000 },
})
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 6: Write `src/daemon/types.ts`**

```ts
export type PushMode = 'push' | 'pull'

export interface AgentContext {
  claude_md_summary?: string
  claude_md_hash?: string
  repo?: { root: string; branch: string; remote?: string }
  manifest?: { type: string; name: string; key_deps: string[] }
}

export interface Agent {
  id: string
  name: string
  description: string
  working_dir: string
  status: string
  connected_since: string  // ISO
  last_activity: string    // ISO
  supports_push: boolean
  context: AgentContext
}

export type WireItemKind = 'note' | 'request' | 'question'
export type WireItemPriority = 'normal' | 'high'

export interface WireItem {
  id: string
  from: string
  to: string                // agent name or "*"
  kind: WireItemKind
  priority: WireItemPriority
  body: string
  timestamp: string
  read: boolean
  delivered_push: boolean
}

export interface LogEntry {
  id: string
  agent: string
  entry: string
  timestamp: string
}

export type WireEvent =
  | { type: 'agent_joined'; agent: Agent }
  | { type: 'agent_left'; name: string }
  | { type: 'status_changed'; name: string; status: string }
  | { type: 'item_sent'; item: WireItem }
  | { type: 'item_read'; name: string; ids: string[] }
  | { type: 'log_appended'; entry: LogEntry }
```

- [ ] **Step 7: Install and commit scaffold**

```bash
pnpm install
git add -A
git commit -m "chore: project scaffold for agent-wire"
```

---

## Task 1: State layer

**Files:**
- Create: `src/daemon/state.ts`, `src/daemon/events.ts`
- Test: `tests/state.test.ts`

- [ ] **Step 1: Write `src/daemon/events.ts`**

```ts
import { WireEvent } from './types.js'

type Listener = (e: WireEvent) => void

export class EventBus {
  private listeners = new Set<Listener>()
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(e: WireEvent) {
    for (const fn of this.listeners) fn(e)
  }
}
```

- [ ] **Step 2: Write failing tests `tests/state.test.ts`**

```ts
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
    expect(s.readPending('b')).toEqual([]) // marked read
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
})
```

- [ ] **Step 3: Run tests, confirm they fail**

```bash
pnpm test state
```

Expected: all fail with "State is not a constructor" / cannot find.

- [ ] **Step 4: Implement `src/daemon/state.ts`**

```ts
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
  private agents = new Map<string, Agent>()       // keyed by name
  private inbox = new Map<string, WireItem[]>()   // keyed by recipient name
  private log: LogEntry[] = []

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
      timestamp: new Date().toISOString(),
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
```

- [ ] **Step 5: Tests green**

```bash
pnpm test state
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(daemon): in-memory state + event bus"
```

---

## Task 2: Shared zod schemas

**Files:**
- Create: `src/shared/schemas.ts`
- Test: inline in mcp.test.ts (Task 4)

- [ ] **Step 1: Write `src/shared/schemas.ts`**

```ts
import { z } from 'zod'

export const ContextSchema = z.object({
  claude_md_summary: z.string().optional(),
  claude_md_hash: z.string().optional(),
  repo: z.object({
    root: z.string(),
    branch: z.string(),
    remote: z.string().optional(),
  }).optional(),
  manifest: z.object({
    type: z.string(),
    name: z.string(),
    key_deps: z.array(z.string()),
  }).optional(),
}).default({})

export const RegisterInput = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  working_dir: z.string(),
  context: ContextSchema,
})

export const StatusInput = z.object({
  agent_id: z.string(),
  status: z.string(),
})

export const DescribeInput = z.object({ agent: z.string() })

export const SendInput = z.object({
  to: z.string().min(1),
  kind: z.enum(['note', 'request', 'question']),
  body: z.string().min(1),
  priority: z.enum(['normal', 'high']).default('normal'),
})

export const ReadInput = z.object({ agent_id: z.string() })

export const LogInput = z.object({
  agent_id: z.string(),
  entry: z.string().min(1),
})

export const LogReadInput = z.object({
  since: z.string().optional(),
})
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat(shared): zod schemas for wire_* tool inputs"
```

---

## Task 3: MCP handler (HTTP dispatch)

**Files:**
- Create: `src/daemon/mcp.ts`
- Test: `tests/mcp.test.ts`

**Scope:** Implements a plain JSON-RPC-ish dispatch for `wire_*` tools over `POST /mcp`. We're NOT using the full `@modelcontextprotocol/sdk` server here — the daemon serves its own HTTP MCP endpoint. (The bridge uses the SDK on the stdio side.) For v1 we accept a simple `{ tool, args, agent_id? }` shape and return `{ ok, data, pending }`. This is the contract the bridge speaks.

- [ ] **Step 1: Write failing test `tests/mcp.test.ts`**

```ts
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
  })

  it('wire_status updates and piggybacks pending', async () => {
    const reg = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'b', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_send', args: { to: 'a', kind: 'note', body: 'hi', priority: 'normal' }, agent_name: 'b' })
    const res = await dispatchTool(s, { tool: 'wire_status', args: { agent_id: reg.data.agent_id, status: 'working' } })
    expect(res.pending?.length).toBe(1)
    expect(res.pending?.[0].body).toBe('hi')
  })

  it('wire_describe returns full card or 404', async () => {
    await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: 'X', context: { claude_md_summary: 'sum' } }, supports_push: false })
    const ok = await dispatchTool(s, { tool: 'wire_describe', args: { agent: 'a' } })
    expect(ok.data.context.claude_md_summary).toBe('sum')
    const miss = await dispatchTool(s, { tool: 'wire_describe', args: { agent: 'nope' } })
    expect(miss.ok).toBe(false)
  })

  it('wire_log + wire_log_read', async () => {
    const reg = await dispatchTool(s, { tool: 'wire_register', args: { name: 'a', working_dir: '/tmp', description: '', context: {} }, supports_push: false })
    await dispatchTool(s, { tool: 'wire_log', args: { agent_id: reg.data.agent_id, entry: 'decision' } })
    const res = await dispatchTool(s, { tool: 'wire_log_read', args: {} })
    expect(res.data.length).toBe(1)
    expect(res.data[0].entry).toBe('decision')
  })

  it('rejects unknown tool', async () => {
    const res = await dispatchTool(s, { tool: 'wire_bogus', args: {} } as any)
    expect(res.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run — confirm fail**

```bash
pnpm test mcp
```

- [ ] **Step 3: Implement `src/daemon/mcp.ts`**

```ts
import { State } from './state.js'
import {
  RegisterInput, StatusInput, DescribeInput, SendInput, ReadInput, LogInput, LogReadInput,
} from '../shared/schemas.js'

export interface DispatchRequest {
  tool: string
  args: unknown
  agent_id?: string       // set by bridge for tools that require an active agent
  agent_name?: string     // resolved from agent_id by bridge; used for from-field on send
  supports_push?: boolean
}

export interface DispatchResult {
  ok: boolean
  data?: any
  error?: string
  pending?: any[]
}

export async function dispatchTool(state: State, req: DispatchRequest): Promise<DispatchResult> {
  try {
    switch (req.tool) {
      case 'wire_register': {
        const args = RegisterInput.parse(req.args)
        const { agent } = state.register({
          name: args.name,
          description: args.description,
          working_dir: args.working_dir,
          supports_push: req.supports_push ?? false,
          context: args.context,
        })
        return { ok: true, data: { agent_id: agent.id, name: agent.name } }
      }
      case 'wire_status': {
        const args = StatusInput.parse(req.args)
        state.setStatus(args.agent_id, args.status)
        const agent = state.list().find(a => a.id === args.agent_id)
        const pending = agent ? state.readPending(agent.name) : []
        return { ok: true, data: { ok: true }, pending }
      }
      case 'wire_list': {
        const list = state.list().map(a => ({
          agent_id: a.id,
          name: a.name,
          description: a.description,
          status: a.status,
          working_dir: a.working_dir,
          branch: a.context.repo?.branch,
          connected_since: a.connected_since,
          last_activity: a.last_activity,
          supports_push: a.supports_push,
        }))
        return { ok: true, data: list }
      }
      case 'wire_describe': {
        const args = DescribeInput.parse(req.args)
        const agent = state.get(args.agent)
        if (!agent) return { ok: false, error: `no such agent: ${args.agent}` }
        return { ok: true, data: agent }
      }
      case 'wire_send': {
        const args = SendInput.parse(req.args)
        const from = req.agent_name
        if (!from) return { ok: false, error: 'wire_send requires caller agent identity' }
        const item = state.send({ from, to: args.to, kind: args.kind, priority: args.priority, body: args.body })
        return { ok: true, data: { id: item.id } }
      }
      case 'wire_read': {
        const args = ReadInput.parse(req.args)
        const agent = state.list().find(a => a.id === args.agent_id)
        if (!agent) return { ok: false, error: 'unknown agent_id' }
        const pending = state.readPending(agent.name)
        return { ok: true, data: pending }
      }
      case 'wire_log': {
        const args = LogInput.parse(req.args)
        const agent = state.list().find(a => a.id === args.agent_id)
        if (!agent) return { ok: false, error: 'unknown agent_id' }
        const entry = state.appendLog({ agent: agent.name, entry: args.entry })
        return { ok: true, data: entry }
      }
      case 'wire_log_read': {
        const args = LogReadInput.parse(req.args)
        return { ok: true, data: state.readLog(args.since) }
      }
      default:
        return { ok: false, error: `unknown tool: ${req.tool}` }
    }
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) }
  }
}
```

- [ ] **Step 4: Green**

```bash
pnpm test mcp
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(daemon): wire_* tool dispatch"
```

---

## Task 4: HTTP server + REST endpoints + SSE

**Files:**
- Create: `src/daemon/server.ts`, `src/daemon/rest.ts`
- Test: `tests/rest.test.ts`

- [ ] **Step 1: Write `src/daemon/rest.ts`**

```ts
import { IncomingMessage, ServerResponse } from 'node:http'
import { State } from './state.js'

export function handleApiAgents(state: State, res: ServerResponse) {
  json(res, 200, state.list())
}

export function handleApiAgent(state: State, name: string, res: ServerResponse) {
  const a = state.get(name)
  if (!a) return json(res, 404, { error: 'not found' })
  json(res, 200, a)
}

export function handleApiLog(state: State, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '', 'http://localhost')
  const since = url.searchParams.get('since') ?? undefined
  json(res, 200, state.readLog(since))
}

export function handleApiEvents(state: State, res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.write(': connected\n\n')
  const unsub = state.bus.subscribe(evt => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`)
  })
  res.on('close', () => unsub())
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
```

- [ ] **Step 2: Write `src/daemon/server.ts`**

```ts
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { State } from './state.js'
import { dispatchTool } from './mcp.js'
import { handleApiAgents, handleApiAgent, handleApiLog, handleApiEvents } from './rest.js'
import { renderDashboard } from './dashboard.js'

export interface ServerHandle {
  port: number
  close(): Promise<void>
}

export function startServer(state: State, port = 4040): Promise<ServerHandle> {
  const server = createServer(async (req, res) => {
    try {
      // loopback guard: reject anything that didn't come in over 127.0.0.1
      const remote = req.socket.remoteAddress ?? ''
      if (!remote.includes('127.0.0.1') && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403); res.end('forbidden: loopback only'); return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'POST' && path === '/mcp') return handleMcp(state, req, res)
      if (req.method === 'GET' && path === '/api/agents') return handleApiAgents(state, res)
      if (req.method === 'GET' && path.startsWith('/api/agents/')) {
        const name = decodeURIComponent(path.slice('/api/agents/'.length))
        return handleApiAgent(state, name, res)
      }
      if (req.method === 'GET' && path === '/api/log') return handleApiLog(state, req, res)
      if (req.method === 'GET' && path === '/api/events') return handleApiEvents(state, res)
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderDashboard())
        return
      }

      res.writeHead(404); res.end('not found')
    } catch (e: any) {
      res.writeHead(500); res.end(e?.message ?? 'error')
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => new Promise(r => server.close(() => r())),
      })
    })
  })
}

async function handleMcp(state: State, req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req)
  let parsed: any
  try { parsed = JSON.parse(body) } catch { res.writeHead(400); res.end('bad json'); return }
  const result = await dispatchTool(state, parsed)
  res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => data += chunk)
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
```

- [ ] **Step 3: Create `src/daemon/dashboard.ts` stub (so imports compile)**

```ts
export function renderDashboard(): string {
  return '<!doctype html><html><body><h1>agent-wire</h1><p>dashboard placeholder</p></body></html>'
}
```

(Real dashboard in Task 7.)

- [ ] **Step 4: Write `tests/rest.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { State } from '../src/daemon/state.js'
import { startServer, ServerHandle } from '../src/daemon/server.js'

async function pickPort(): Promise<number> {
  return 4050 + Math.floor(Math.random() * 500)
}

describe('HTTP server', () => {
  let state: State
  let srv: ServerHandle
  let base: string

  beforeEach(async () => {
    state = new State()
    srv = await startServer(state, await pickPort())
    base = `http://127.0.0.1:${srv.port}`
  })
  afterEach(async () => { await srv.close() })

  it('POST /mcp wire_register then GET /api/agents', async () => {
    const reg = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'wire_register', args: { name: 'a', description: '', working_dir: '/tmp', context: {} }, supports_push: false }),
    })
    expect(reg.status).toBe(200)
    const agents = await (await fetch(`${base}/api/agents`)).json()
    expect(agents.length).toBe(1)
    expect(agents[0].name).toBe('a')
  })

  it('GET /api/events streams SSE', async () => {
    const ctrl = new AbortController()
    const resP = fetch(`${base}/api/events`, { signal: ctrl.signal })
    const res = await resP
    const reader = res.body!.getReader()
    const firstChunk = await reader.read()
    expect(new TextDecoder().decode(firstChunk.value)).toContain(': connected')

    // trigger an event
    fetch(`${base}/mcp`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'wire_register', args: { name: 'x', description: '', working_dir: '/tmp', context: {} }, supports_push: false }),
    })

    const next = await reader.read()
    expect(new TextDecoder().decode(next.value)).toContain('agent_joined')
    ctrl.abort()
  })

  it('GET / serves html', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})
```

- [ ] **Step 5: Run & iterate until green**

```bash
pnpm test rest
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(daemon): HTTP server, REST + SSE endpoints"
```

---

## Task 5: Daemon bin entry

**Files:**
- Create: `src/daemon/index.ts`

- [ ] **Step 1: Implement**

```ts
#!/usr/bin/env node
import { State } from './state.js'
import { startServer } from './server.js'

const PORT = Number(process.env.AGENT_WIRE_PORT ?? 4040)

async function main() {
  const state = new State()
  const srv = await startServer(state, PORT)
  // eslint-disable-next-line no-console
  console.error(`[agent-wire] daemon on http://127.0.0.1:${srv.port}`)
  process.on('SIGINT', async () => { await srv.close(); process.exit(0) })
  process.on('SIGTERM', async () => { await srv.close(); process.exit(0) })
}

main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Sanity run**

```bash
pnpm dev:daemon &
sleep 1
curl -s http://127.0.0.1:4040/api/agents
kill %1
```

Expected: `[]`

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(daemon): bin entry"
```

---

## Task 6: Project sniff (repo + manifest auto-fill)

**Files:**
- Create: `src/bridge/projectSniff.ts`
- Test: `tests/projectSniff.test.ts`

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { sniffProject } from '../src/bridge/projectSniff.js'

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'wire-sniff-'))
  return d
}

describe('sniffProject', () => {
  it('reads package.json manifest', () => {
    const d = tmp()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'foo', dependencies: { next: '15', react: '19' } }))
    const c = sniffProject(d)
    expect(c.manifest?.type).toBe('package.json')
    expect(c.manifest?.name).toBe('foo')
    expect(c.manifest?.key_deps).toContain('next@15')
  })

  it('reads git repo info', () => {
    const d = tmp()
    execSync('git init -q && git checkout -q -b main && git commit -q --allow-empty -m init', { cwd: d })
    const c = sniffProject(d)
    expect(c.repo?.root).toBe(d)
    expect(c.repo?.branch).toBe('main')
  })

  it('handles no repo, no manifest gracefully', () => {
    const d = tmp()
    const c = sniffProject(d)
    expect(c.repo).toBeUndefined()
    expect(c.manifest).toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement `src/bridge/projectSniff.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { AgentContext } from '../daemon/types.js'

export function sniffProject(dir: string): Pick<AgentContext, 'repo' | 'manifest'> {
  const out: Pick<AgentContext, 'repo' | 'manifest'> = {}

  // git
  try {
    const root = execSync('git rev-parse --show-toplevel', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const branch = execSync('git branch --show-current', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    let remote: string | undefined
    try { remote = execSync('git remote get-url origin', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch {}
    out.repo = { root, branch: branch || '(detached)', remote }
  } catch {}

  // manifest
  const candidates: Array<[string, (p: string) => { type: string; name: string; key_deps: string[] }]> = [
    ['package.json', p => {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }
      return { type: 'package.json', name: j.name ?? '(unnamed)', key_deps: topDeps(deps, 8) }
    }],
    ['Gemfile', p => {
      const src = readFileSync(p, 'utf8')
      const deps = [...src.matchAll(/^gem ['"]([^'"]+)['"]/gm)].map(m => m[1])
      return { type: 'Gemfile', name: inferName(p), key_deps: deps.slice(0, 8) }
    }],
    ['pyproject.toml', p => {
      const src = readFileSync(p, 'utf8')
      const name = src.match(/name\s*=\s*"([^"]+)"/)?.[1] ?? '(unnamed)'
      const deps = [...src.matchAll(/"([a-zA-Z0-9_\-]+)[=<>~!]/g)].map(m => m[1])
      return { type: 'pyproject.toml', name, key_deps: [...new Set(deps)].slice(0, 8) }
    }],
    ['Cargo.toml', p => {
      const src = readFileSync(p, 'utf8')
      const name = src.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/)?.[1] ?? '(unnamed)'
      return { type: 'Cargo.toml', name, key_deps: [] }
    }],
    ['go.mod', p => {
      const src = readFileSync(p, 'utf8')
      const name = src.match(/^module\s+(\S+)/m)?.[1] ?? '(unnamed)'
      return { type: 'go.mod', name, key_deps: [] }
    }],
  ]
  for (const [file, parse] of candidates) {
    const p = join(dir, file)
    if (existsSync(p)) {
      try { out.manifest = parse(p); break } catch {}
    }
  }

  return out
}

function topDeps(deps: Record<string, string>, n: number): string[] {
  return Object.entries(deps).slice(0, n).map(([k, v]) => `${k}@${v.replace(/^[\^~]/, '')}`)
}
function inferName(p: string): string {
  return p.split('/').slice(-2, -1)[0] ?? '(unnamed)'
}
```

- [ ] **Step 3: Green + commit**

```bash
pnpm test projectSniff
git add -A && git commit -m "feat(bridge): project sniff for repo+manifest"
```

---

## Task 7: Dashboard SPA

**Files:**
- Create: `src/dashboard/index.html`
- Modify: `src/daemon/dashboard.ts` to inline the HTML at build time (via `readFileSync(import.meta.url)`)

- [ ] **Step 1: Write `src/dashboard/index.html`**

Full SPA: vanilla JS, subscribes to `/api/events`, renders Agents panel (left), Activity feed (middle), Shared log tab (right), topbar stats. Color-hash per agent name.

(Complete HTML — ~300 lines vanilla JS, no framework. Writing inline here would bloat the plan; see implementation at task execution time. Must cover: initial fetch of `/api/agents` + `/api/log`, SSE subscription applying `agent_joined`/`agent_left`/`status_changed`/`item_sent`/`log_appended` to local state, three-column layout, color-hash, status dots, filter input, JSON copy affordance.)

- [ ] **Step 2: Update `src/daemon/dashboard.ts`**

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HTML = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  // during build, dashboard/index.html is copied next to daemon/dashboard.js
  const candidates = [
    join(here, '../dashboard/index.html'),
    join(here, 'dashboard.html'),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf8') } catch {}
  }
  return '<!doctype html><html><body>dashboard missing</body></html>'
})()

export function renderDashboard(): string { return HTML }
```

- [ ] **Step 3: Add to `package.json` build step so HTML is copied into dist**

Modify the `build` script:

```json
"build": "tsc && mkdir -p dist/dashboard && cp src/dashboard/index.html dist/dashboard/index.html"
```

- [ ] **Step 4: Manual smoke test**

```bash
pnpm dev:daemon &
open http://127.0.0.1:4040/
# visually verify dashboard loads empty state
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(daemon): dashboard SPA"
```

---

## Task 8: Daemon HTTP client (used by bridge)

**Files:**
- Create: `src/bridge/daemonClient.ts`

- [ ] **Step 1: Implement**

```ts
export class DaemonClient {
  constructor(private base = 'http://127.0.0.1:4040') {}

  async call(tool: string, args: unknown, extra: { agent_id?: string; agent_name?: string; supports_push?: boolean } = {}) {
    const res = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args, ...extra }),
    })
    return res.json() as Promise<{ ok: boolean; data?: any; error?: string; pending?: any[] }>
  }

  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/api/agents`, { signal: AbortSignal.timeout(500) })
      return res.ok
    } catch { return false }
  }

  subscribeEvents(onEvent: (evt: any) => void, onError: (e: unknown) => void): () => void {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(`${this.base}/api/events`, { signal: ctrl.signal })
        const reader = res.body!.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const p of parts) {
            const line = p.split('\n').find(l => l.startsWith('data: '))
            if (line) {
              try { onEvent(JSON.parse(line.slice(6))) } catch {}
            }
          }
        }
      } catch (e) { if (!ctrl.signal.aborted) onError(e) }
    })()
    return () => ctrl.abort()
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat(bridge): daemon HTTP client"
```

---

## Task 9: Lazy daemon starter

**Files:**
- Create: `src/bridge/lazyDaemon.ts`
- Test: `tests/lazyDaemon.test.ts`

- [ ] **Step 1: Implement `src/bridge/lazyDaemon.ts`**

```ts
import { spawn } from 'node:child_process'
import { DaemonClient } from './daemonClient.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export async function ensureDaemon(): Promise<void> {
  const client = new DaemonClient()
  if (await client.probe()) return

  // find daemon bin relative to this file
  const here = dirname(fileURLToPath(import.meta.url))
  const daemonBin = join(here, '../daemon/index.js')

  const child = spawn(process.execPath, [daemonBin], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  child.unref()

  // wait until probe succeeds (max 3s)
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (await client.probe()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('agent-wire daemon failed to start within 3s')
}
```

- [ ] **Step 2: Write test `tests/lazyDaemon.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { ensureDaemon } from '../src/bridge/lazyDaemon.js'
import { DaemonClient } from '../src/bridge/daemonClient.js'

// NOTE: This test assumes `pnpm build` has been run (so dist/daemon/index.js exists).
describe.skip('ensureDaemon (requires built dist/)', () => {
  it('starts the daemon if not running and becomes reachable', async () => {
    await ensureDaemon()
    const c = new DaemonClient()
    expect(await c.probe()).toBe(true)
  })
})
```

(Kept as `describe.skip` by default because it depends on build + leaves a background process. Can be enabled manually.)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(bridge): lazy daemon starter"
```

---

## Task 10: Bridge MCP server (stdio + channel)

**Files:**
- Create: `src/bridge/channel.ts`, `src/bridge/index.ts`

- [ ] **Step 1: Write `src/bridge/channel.ts`** — wraps a daemon SSE subscription and turns relevant events into `notifications/claude/channel` on the bound MCP server.

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { DaemonClient } from './daemonClient.js'

// Emits only the items addressed to `selfName` (name-based filter), as channel
// notifications. Broadcast items (`to: "*"`) are included except when sender === self.
export function startChannelPump(mcp: Server, daemon: DaemonClient, getSelfName: () => string | null): () => void {
  const unsub = daemon.subscribeEvents(
    evt => {
      const self = getSelfName()
      if (!self) return
      if (evt.type !== 'item_sent') return
      const item = evt.item
      const isForMe =
        item.to === self ||
        (item.to === '*' && item.from !== self)
      if (!isForMe) return
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: item.body,
          meta: {
            from: item.from,
            kind: item.kind,
            priority: item.priority,
          },
        },
      }).catch(() => {})
    },
    () => {},
  )
  return unsub
}
```

- [ ] **Step 2: Write `src/bridge/index.ts`**

```ts
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ensureDaemon } from './lazyDaemon.js'
import { DaemonClient } from './daemonClient.js'
import { sniffProject } from './projectSniff.js'
import { startChannelPump } from './channel.js'

const TOOL_DEFS = [
  { name: 'wire_register', description: 'Register this agent on the wire and publish project context.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, working_dir: { type: 'string' }, context: { type: 'object' } }, required: ['name', 'working_dir'] } },
  { name: 'wire_status',   description: 'Announce current task.', inputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } },
  { name: 'wire_list',     description: 'List agents on the wire.', inputSchema: { type: 'object', properties: {} } },
  { name: 'wire_describe', description: 'Full project card for an agent.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
  { name: 'wire_send',     description: 'Pass a note/request/question to another agent or "*".', inputSchema: { type: 'object', properties: { to: { type: 'string' }, kind: { type: 'string', enum: ['note','request','question'] }, body: { type: 'string' }, priority: { type: 'string', enum: ['normal','high'] } }, required: ['to','kind','body'] } },
  { name: 'wire_read',     description: 'Pull unread items (fallback for clients without push).', inputSchema: { type: 'object', properties: {} } },
  { name: 'wire_log',      description: 'Append to the shared decisions log.', inputSchema: { type: 'object', properties: { entry: { type: 'string' } }, required: ['entry'] } },
  { name: 'wire_log_read', description: 'Read the shared log.', inputSchema: { type: 'object', properties: { since: { type: 'string' } } } },
]

async function main() {
  await ensureDaemon()
  const daemon = new DaemonClient()

  let selfId: string | null = null
  let selfName: string | null = null

  const mcp = new Server(
    { name: 'agent-wire', version: '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions:
        'You are on agent-wire, a private internal bus shared with other coding agents running on this machine. ' +
        'Items from other agents arrive as <channel source="agent-wire" from="..." kind="..." priority="..."> tags. ' +
        'Read them, act on them, and reply via the wire_send tool. Nothing on agent-wire leaves this machine.',
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as any

    // auto-enrich register with sniffed repo/manifest if missing
    if (name === 'wire_register') {
      const sniffed = sniffProject(args.working_dir ?? process.cwd())
      args.context = { ...sniffed, ...(args.context ?? {}) }
    }

    // attach caller identity where needed
    const extra: { agent_id?: string; agent_name?: string; supports_push?: boolean } = {
      supports_push: true,
    }
    if (name !== 'wire_register') extra.agent_id = selfId ?? undefined
    if (name === 'wire_send' || name === 'wire_status' || name === 'wire_log' || name === 'wire_read') {
      extra.agent_name = selfName ?? undefined
    }

    // wire_status / wire_log / wire_read need agent_id in args (the dispatch contract)
    if (name === 'wire_status' || name === 'wire_log' || name === 'wire_read') {
      args.agent_id = selfId
    }

    const result = await daemon.call(name, args, extra)

    if (name === 'wire_register' && result.ok) {
      selfId = result.data.agent_id
      selfName = result.data.name
    }

    const content = [{ type: 'text' as const, text: JSON.stringify(result) }]
    return { content }
  })

  const unsub = startChannelPump(mcp, daemon, () => selfName)

  // heartbeat
  const hb = setInterval(() => {
    if (selfId) daemon.call('wire_status', { agent_id: selfId, status: '' /* empty = touch only */ }).catch(() => {})
  }, 10_000)
  // NOTE: empty-status touch is a hack; a dedicated `wire_touch` is cleaner — see Future.

  await mcp.connect(new StdioServerTransport())

  process.on('SIGTERM', () => { clearInterval(hb); unsub() })
}

main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2a: Add `wire_touch` tool** to avoid the empty-status hack.

In `src/shared/schemas.ts`:

```ts
export const TouchInput = z.object({ agent_id: z.string() })
```

In `src/daemon/mcp.ts`, add case:

```ts
case 'wire_touch': {
  const args = TouchInput.parse(req.args)
  state.touch(args.agent_id)
  return { ok: true, data: { ok: true } }
}
```

In bridge heartbeat: `daemon.call('wire_touch', { agent_id: selfId })`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(bridge): stdio MCP server + channel pump + heartbeat"
```

---

## Task 11: End-to-end test

**Files:**
- Test: `tests/e2e.test.ts`

- [ ] **Step 1: Write test — two in-process "agents" registering against one real daemon, exchanging a message, verifying pending piggyback**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { State } from '../src/daemon/state.js'
import { startServer, ServerHandle } from '../src/daemon/server.js'
import { DaemonClient } from '../src/bridge/daemonClient.js'

describe('e2e', () => {
  let srv: ServerHandle
  let client: DaemonClient

  beforeAll(async () => {
    srv = await startServer(new State(), 4099)
    client = new DaemonClient('http://127.0.0.1:4099')
  })
  afterAll(async () => { await srv.close() })

  it('two agents exchange a message and see it via piggyback', async () => {
    const a = await client.call('wire_register', { name: 'alice', description: '', working_dir: '/tmp', context: {} }, { supports_push: true })
    const b = await client.call('wire_register', { name: 'bob',   description: '', working_dir: '/tmp', context: {} }, { supports_push: false })
    expect(a.ok && b.ok).toBe(true)

    const sent = await client.call('wire_send', { to: 'alice', kind: 'note', body: 'hello', priority: 'normal' }, { agent_name: 'bob' })
    expect(sent.ok).toBe(true)

    const status = await client.call('wire_status', { agent_id: a.data.agent_id, status: 'working' }, { agent_name: 'alice' })
    expect(status.ok).toBe(true)
    expect(status.pending?.[0]?.body).toBe('hello')
  })

  it('broadcast reaches all except sender', async () => {
    const c = await client.call('wire_register', { name: 'carol', description: '', working_dir: '/tmp', context: {} }, { supports_push: true })
    await client.call('wire_send', { to: '*', kind: 'note', body: 'broadcast', priority: 'normal' }, { agent_name: 'carol' })
    const alice = await client.call('wire_read', { agent_id: (await client.call('wire_list', {})).data.find((a: any) => a.name === 'alice').agent_id }, { agent_name: 'alice' })
    expect(alice.data.some((i: any) => i.body === 'broadcast')).toBe(true)
  })
})
```

- [ ] **Step 2: Green + commit**

```bash
pnpm test e2e
git add -A && git commit -m "test: e2e flow with live daemon"
```

---

## Task 12: README

**Files:** `README.md`

- [ ] **Step 1: Write a short, modern-MCP-style README**

Sections:
1. **agent-wire** — one-paragraph pitch ("private local bus for your coding agents")
2. **Demo GIF** placeholder
3. **Install** — `claude mcp add --scope user agent-wire -- npx -y agent-wire-bridge`
4. **Launch** — `claude --dangerously-load-development-channels server:agent-wire` (+ research-preview caveats explicit)
5. **CLAUDE.md snippet** — copy-paste block from the spec
6. **Dashboard** — screenshot placeholder + `http://127.0.0.1:4040/`
7. **How it works** — 3-sentence version
8. **Tools** — bullet list of `wire_*` with one-liners
9. **Privacy / scope** — "loopback only, in-memory only, nothing leaves your machine"
10. **Status** — "early, channels is in research preview, expect bumps"
11. **License** — MIT

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs: README"
```

---

## Task 13: Publish prep

**Files:** `package.json`, `.npmignore`

- [ ] **Step 1: Add `.npmignore`**

```
src/
tests/
docs/
tsconfig.json
vitest.config.ts
.git/
*.md.bak
```

- [ ] **Step 2: `prepublishOnly` script** — ensure build runs

```json
"prepublishOnly": "pnpm build && pnpm test"
```

- [ ] **Step 3: Dry-run**

```bash
pnpm pack --dry-run
```

Verify `dist/daemon/index.js`, `dist/bridge/index.js`, `dist/dashboard/index.html`, `README.md` are in the tarball and nothing else unexpected.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: publish config"
```

---

## Acceptance

At the end of Task 13:

1. `pnpm build && pnpm test` → all green
2. `pnpm dev:daemon` → daemon serves `http://127.0.0.1:4040/`, dashboard renders
3. Two manual `curl`s against `/mcp` can register two agents, exchange a message, and see it piggybacked
4. `pnpm pack --dry-run` produces a clean tarball
5. README is ready to push to GitHub
