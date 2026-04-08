#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ensureDaemon } from './lazyDaemon.js'
import { DaemonClient } from './daemonClient.js'
import { sniffProject, findClaudeMd, hashClaudeMd } from './projectSniff.js'
import { startChannelPump } from './channel.js'

const TOOL_DEFS = [
  {
    name: 'wire_register',
    description: 'Join the wire. Publishes your project context (CLAUDE.md summary, repo, manifest) so other agents can discover you. Call once at session start.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short role-based name, e.g. "frontend-agent"' },
        description: { type: 'string', description: 'One-line description of this agent' },
        working_dir: { type: 'string', description: 'Absolute path to the project root' },
        context: {
          type: 'object',
          description: 'Optional context overrides. The bridge auto-fills repo and manifest from working_dir; you should provide claude_md_summary as a ≤10-bullet summary of the local CLAUDE.md.',
          properties: {
            claude_md_summary: { type: 'string' },
          },
        },
      },
      required: ['name', 'working_dir'],
    },
  },
  {
    name: 'wire_status',
    description: 'Announce what you are currently working on. Call before starting a task.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
    },
  },
  {
    name: 'wire_list',
    description: 'List all agents currently on the wire (lightweight, no project cards).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wire_describe',
    description: 'Get the full project card (CLAUDE.md summary, repo, manifest) for a specific agent.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' } },
      required: ['agent'],
    },
  },
  {
    name: 'wire_send',
    description: 'Pass a note, request, or question to another agent (or "*" for everyone). Notes are FYI; requests ask for action; questions ask for an answer.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target agent name, or "*" for broadcast' },
        kind: { type: 'string', enum: ['note', 'request', 'question'] },
        body: { type: 'string' },
        priority: { type: 'string', enum: ['normal', 'high'], default: 'normal' },
      },
      required: ['to', 'kind', 'body'],
    },
  },
  {
    name: 'wire_read',
    description: 'Pull unread items addressed to you. Fallback for clients without channel push; Claude Code receives items automatically as <channel> tags.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wire_log',
    description: 'Append an entry to the shared decisions log (visible to all agents and the dashboard).',
    inputSchema: {
      type: 'object',
      properties: { entry: { type: 'string' } },
      required: ['entry'],
    },
  },
  {
    name: 'wire_log_read',
    description: 'Read the shared decisions log. Optional `since` ISO timestamp filter.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' } },
    },
  },
  {
    name: 'wire_deregister',
    description: 'Leave the wire. The bridge calls this automatically on session exit; you normally don\'t need to call it yourself.',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function main() {
  await ensureDaemon()
  const daemon = new DaemonClient()

  let selfId: string | null = null
  let selfName: string | null = null
  let claudeMdPath: string | null = null
  let claudeMdHash: string | null = null

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
        'Read them, act on them, and reply via the wire_send tool when appropriate. ' +
        'Nothing on agent-wire leaves this machine.',
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const name = req.params.name
    const args: Record<string, unknown> = { ...(req.params.arguments ?? {}) }

    // wire_register: enrich with sniffed project info + CLAUDE.md hash
    if (name === 'wire_register') {
      const workingDir = (args.working_dir as string | undefined) ?? process.cwd()
      const sniffed = sniffProject(workingDir)
      // Compute CLAUDE.md path and hash
      claudeMdPath = findClaudeMd(workingDir)
      claudeMdHash = claudeMdPath ? hashClaudeMd(claudeMdPath) : null
      const hashContext = claudeMdHash ? { claude_md_hash: claudeMdHash } : {}
      args.context = { ...sniffed, ...hashContext, ...((args.context as Record<string, unknown> | undefined) ?? {}) }
    }

    // wire_deregister: inject selfId
    if (name === 'wire_deregister') {
      if (!selfId) return errResult('not registered yet — call wire_register first')
      args.agent_id = selfId
    }

    // tools that need agent_id in their args (per the dispatch contract)
    if (name === 'wire_status' || name === 'wire_log' || name === 'wire_read') {
      if (!selfId) {
        return errResult('not registered yet — call wire_register first')
      }
      args.agent_id = selfId
    }

    // Always pass selfId/selfName as extra when known (enables universal piggyback)
    const extra: { agent_id?: string; agent_name?: string; supports_push?: boolean } = {
      supports_push: true,
    }
    if (selfId) extra.agent_id = selfId
    if (selfName) extra.agent_name = selfName
    // wire_send specifically requires agent_name for the from field
    if (name === 'wire_send' && !selfName) {
      return errResult('not registered yet — call wire_register first')
    }

    // Check CLAUDE.md hash drift on wire_status
    let hashNudge: any[] | undefined
    if (name === 'wire_status' && claudeMdPath) {
      try {
        const currentHash = hashClaudeMd(claudeMdPath)
        if (currentHash !== claudeMdHash) {
          hashNudge = [{
            from: 'agent-wire',
            kind: 'note',
            priority: 'high',
            body: 'Your CLAUDE.md changed since wire_register. Please re-summarize it (≤10 bullets) and call wire_register again to refresh your project card.',
          }]
          // Don't update claudeMdHash here — keep nudging until they re-register
        }
      } catch {}
    }

    const result = await daemon.call(name, args, extra)

    if (name === 'wire_register' && result.ok && result.data) {
      selfId = result.data.agent_id as string
      selfName = result.data.name as string
      // After re-register, update the hash to the current state
      if (claudeMdPath) {
        try { claudeMdHash = hashClaudeMd(claudeMdPath) } catch {}
      }
    }

    // Inject hash nudge into pending if applicable
    if (hashNudge && result.ok) {
      result.pending = [...(result.pending ?? []), ...hashNudge]
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    }
  })

  const unsubChannel = startChannelPump(mcp, daemon, () => selfName)

  // heartbeat every 10s once we're registered
  const hb = setInterval(() => {
    if (!selfId) return
    daemon.call('wire_touch', { agent_id: selfId }).catch(() => {})
  }, 10_000)
  hb.unref?.()

  async function gracefulExit() {
    if (selfId) {
      try { await daemon.call('wire_deregister', { agent_id: selfId }) } catch {}
    }
    clearInterval(hb)
    unsubChannel()
  }

  process.on('SIGINT',  () => { gracefulExit().finally(() => process.exit(0)) })
  process.on('SIGTERM', () => { gracefulExit().finally(() => process.exit(0)) })

  const transport = new StdioServerTransport()
  // Hook stdio transport close — fires when stdin closes (e.g. /exit in Claude Code)
  transport.onclose = () => { gracefulExit().finally(() => process.exit(0)) }

  await mcp.connect(transport)
}

function errResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }],
    isError: true,
  }
}

main().catch(e => {
  console.error('[agent-wire-bridge] fatal:', e)
  process.exit(1)
})
