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
