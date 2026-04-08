import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { State } from './state.js'
import { dispatchTool } from './mcp.js'
import { handleApiAgents, handleApiAgent, handleApiLog, handleApiEvents } from './rest.js'
import { renderDashboard } from './dashboard.js'

export interface ServerHandle {
  port: number
  close(): Promise<void>
}

export function startServer(state: State, port = 4747): Promise<ServerHandle> {
  const server = createServer(async (req, res) => {
    try {
      const remote = req.socket.remoteAddress ?? ''
      if (!isLoopback(remote)) {
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

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
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
