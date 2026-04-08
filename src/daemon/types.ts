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
  connected_since: string
  last_activity: string
  supports_push: boolean
  context: AgentContext
}

export type WireItemKind = 'note' | 'request' | 'question'
export type WireItemPriority = 'normal' | 'high'

export interface WireItem {
  id: string
  from: string
  to: string
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
