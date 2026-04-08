import { State } from './state.js'
import {
  RegisterInput, StatusInput, TouchInput, DescribeInput, SendInput, ReadInput, LogInput, LogReadInput,
} from '../shared/schemas.js'

export interface DispatchRequest {
  tool: string
  args: unknown
  agent_id?: string
  agent_name?: string
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
      case 'wire_touch': {
        const args = TouchInput.parse(req.args)
        state.touch(args.agent_id)
        return { ok: true, data: { ok: true } }
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
    return { ok: false, error: e?.message ?? String(e) }
  }
}
