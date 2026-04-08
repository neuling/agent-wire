import { State } from './state.js'
import {
  RegisterInput, StatusInput, TouchInput, DescribeInput, SendInput, ReadInput, LogInput, LogReadInput,
  DeregisterInput,
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

/** Attach pending items to a successful result for the calling agent (if identifiable). */
function attachPending(result: DispatchResult, state: State, req: DispatchRequest, registeredName?: string): void {
  if (!result.ok) return
  let callerName: string | undefined
  if (req.agent_name) {
    callerName = req.agent_name
  } else if (req.agent_id) {
    callerName = state.getById(req.agent_id)?.name
  } else if (registeredName) {
    callerName = registeredName
  }
  if (!callerName) return
  result.pending = state.readPending(callerName)
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
        const result: DispatchResult = { ok: true, data: { agent_id: agent.id, name: agent.name } }
        attachPending(result, state, req, agent.name)
        return result
      }
      case 'wire_deregister': {
        const args = DeregisterInput.parse(req.args)
        const agent = state.getById(args.agent_id)
        if (agent) {
          state.deregister(agent.name)
        }
        // idempotent — always ok
        return { ok: true, data: { ok: true } }
      }
      case 'wire_status': {
        const args = StatusInput.parse(req.args)
        state.setStatus(args.agent_id, args.status)
        // pending is handled by attachPending via agent_id in args
        const result: DispatchResult = { ok: true, data: { ok: true } }
        // For wire_status the agent_id is in args; pass it via req for piggyback lookup
        const effectiveReq = { ...req, agent_id: args.agent_id }
        attachPending(result, state, effectiveReq)
        return result
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
        const result: DispatchResult = { ok: true, data: list }
        attachPending(result, state, req)
        return result
      }
      case 'wire_describe': {
        const args = DescribeInput.parse(req.args)
        const agent = state.get(args.agent)
        if (!agent) return { ok: false, error: `no such agent: ${args.agent}` }
        const result: DispatchResult = { ok: true, data: agent }
        attachPending(result, state, req)
        return result
      }
      case 'wire_send': {
        const args = SendInput.parse(req.args)
        const from = req.agent_name
        if (!from) return { ok: false, error: 'wire_send requires caller agent identity' }
        const item = state.send({ from, to: args.to, kind: args.kind, priority: args.priority, body: args.body })
        const result: DispatchResult = { ok: true, data: { id: item.id } }
        attachPending(result, state, req)
        return result
      }
      case 'wire_read': {
        // wire_read: pending items ARE the response data; skip attachPending to avoid double-read
        const args = ReadInput.parse(req.args)
        const agent = state.getById(args.agent_id)
        if (!agent) return { ok: false, error: 'unknown agent_id' }
        const pending = state.readPending(agent.name)
        return { ok: true, data: pending }
      }
      case 'wire_log': {
        const args = LogInput.parse(req.args)
        const agent = state.getById(args.agent_id)
        if (!agent) return { ok: false, error: 'unknown agent_id' }
        const entry = state.appendLog({ agent: agent.name, entry: args.entry })
        const result: DispatchResult = { ok: true, data: entry }
        attachPending(result, state, req)
        return result
      }
      case 'wire_log_read': {
        const args = LogReadInput.parse(req.args)
        const result: DispatchResult = { ok: true, data: state.readLog(args.since) }
        attachPending(result, state, req)
        return result
      }
      default:
        return { ok: false, error: `unknown tool: ${req.tool}` }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
