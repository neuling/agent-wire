export interface DaemonCallResult {
  ok: boolean
  data?: any
  error?: string
  pending?: any[]
}

export interface DaemonCallExtras {
  agent_id?: string
  agent_name?: string
  supports_push?: boolean
}

export class DaemonClient {
  constructor(private base = `http://127.0.0.1:${process.env.AGENT_WIRE_PORT ?? 4747}`) {}

  get baseUrl(): string { return this.base }

  async call(tool: string, args: unknown, extra: DaemonCallExtras = {}): Promise<DaemonCallResult> {
    const res = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args, ...extra }),
    })
    // The daemon returns 400 with a JSON body for tool errors; still parse.
    try {
      return await res.json() as DaemonCallResult
    } catch {
      return { ok: false, error: `bad response: ${res.status}` }
    }
  }

  async probe(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/api/agents`, { signal: AbortSignal.timeout(500) })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Subscribe to the daemon's SSE event stream.
   * Returns a disposer that aborts the connection.
   * onError fires on connection drop (not on parse errors).
   */
  subscribeEvents(onEvent: (evt: any) => void, onError: (e: unknown) => void = () => {}): () => void {
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(`${this.base}/api/events`, { signal: ctrl.signal })
        if (!res.body) { onError(new Error('no body')); return }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          // SSE messages are separated by \n\n
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const p of parts) {
            const dataLine = p.split('\n').find(l => l.startsWith('data: '))
            if (!dataLine) continue
            try {
              const parsed = JSON.parse(dataLine.slice(6))
              onEvent(parsed)
            } catch {
              // ignore parse errors (could be the initial ': connected' comment)
            }
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) onError(e)
      }
    })()
    return () => ctrl.abort()
  }
}
