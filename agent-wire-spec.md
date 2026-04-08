# agent-wire

A private, in-process bus that lets coding agents on the same machine see each other and talk to each other. Strictly local, strictly between your own agents. Nothing on agent-wire ever leaves your machine.

Works with any MCP-compatible client (Claude Code, Codex, Cursor, Windsurf, …).
**Claude Code sessions get real-time push via [Channels](https://code.claude.com/docs/en/channels-reference)** — no polling. Other clients fall back to pull via `wire_read`.

---

## What it is

You're running two Claude Code sessions — one on frontend, one on backend. They have no idea the other exists. Backend changes an API response, frontend breaks. You're the messenger in between, copy-pasting context back and forth.

agent-wire gives those sessions a shared internal wire. Each agent announces who it is and what it's working on, sees the others, can pull a short summary of their projects, and can pass notes, questions or requests directly — with push delivery between Claude Code sessions.

This is an **internal agent-to-agent fabric**. It is not a chat bridge. It is not a webhook gateway. It is not reachable from the network. It binds to `127.0.0.1`, holds state in memory only, and exists for the lifetime of your agent sessions. Other machines, other users, other processes outside your own agents have no part in it.

## Architecture

```
┌──────────────┐   stdio    ┌───────────────┐    HTTP/SSE   ┌─────────────┐
│  Agent A      │◄─────────►│  wire bridge  │◄─────────────►│             │
│ (claude code) │            │  (channel)    │               │             │
└──────────────┘            └───────────────┘               │ agent-wire  │
                                                             │   daemon    │
┌──────────────┐   stdio    ┌───────────────┐    HTTP/SSE   │ 127.0.0.1   │
│  Agent B      │◄─────────►│  wire bridge  │◄─────────────►│   :4747     │
│ (claude code) │            │  (channel)    │               │             │
└──────────────┘            └───────────────┘               │   in-mem    │
                                                             │   state     │
┌──────────────┐   stdio    ┌───────────────┐    HTTP/SSE   │             │
│  Agent C      │◄─────────►│  wire bridge  │◄─────────────►│             │
│ (cursor, …)  │            │  (pull only)  │               └─────────────┘
└──────────────┘            └───────────────┘                     ▲
                                                                   │
                                                           ┌───────┴───────┐
                                                           │   Dashboard   │
                                                           │ localhost:4747│
                                                           └───────────────┘
```

One local daemon, bound to `127.0.0.1:4747`. All state in memory. Every agent reaches it the same way:

- **stdio bridge** — a thin MCP subprocess (`agent-wire-bridge`) spawned per agent session. Translates stdio ↔ internal HTTP, and declares the `claude/channel` capability so the daemon can push events straight into Claude Code sessions. Non-Claude-Code clients get the same bridge but without channel push — they pull via `wire_read` and receive pending items piggybacked on every tool response.

The daemon also serves a private dashboard at `http://127.0.0.1:4747/` — a live view of what's happening on the wire (see [Dashboard](#dashboard)).

State is in memory only. No DB, no disk persistence, no outbound connections. Daemon restart wipes everything. That's by design — agents are ephemeral.

---

## MCP Tools

All tools are prefixed `wire_*` to make their scope obvious: this is the internal wire, not the outside world.

### `wire_register`

Called once at session start. Registers the calling agent and publishes its **project context** onto the wire.

```json
{
  "name": "frontend-agent",
  "description": "Next.js frontend",
  "working_dir": "/Users/moritz/project/frontend",
  "context": {
    "claude_md_summary": "Next.js 15 app router. TypeScript strict. Tailwind v4. Auth via Clerk. Tests with vitest. Currently focused on the profile redesign.",
    "repo": {
      "root": "/Users/moritz/project/frontend",
      "branch": "feat/avatar",
      "remote": "github.com/moritz/project"
    },
    "manifest": {
      "type": "package.json",
      "name": "project-web",
      "key_deps": ["next@15", "react@19", "tailwindcss@4", "@clerk/nextjs"]
    }
  }
}
```

Returns: `{ agent_id: string }`.

**Name collisions**: if `frontend-agent` already exists, the daemon appends a short suffix (`frontend-agent-2`) and tells the caller.

**Context is agent-authored**: the client (via its CLAUDE.md rule — see [Setup](#setup)) reads its own CLAUDE.md, summarizes it to ≤10 bullets, and passes it as `context.claude_md_summary`. `repo` and `manifest` are cheap deterministic reads the bridge performs if omitted. The daemon never runs an LLM.

**Auto-deregister**: the daemon tracks liveness via internal heartbeats from the bridge (every 10s). A background reaper runs every 15s and removes any agent whose `last_activity` is older than 30s. The bridge also calls `wire_deregister` explicitly on stdio close, SIGINT, and SIGTERM, so clean exits are instant rather than waiting for the reaper.

### `wire_status`

Announce what you're currently working on. Call before starting a task.

```json
{ "agent_id": "...", "status": "Refactoring UserProfile component to use new /users endpoint" }
```

Response piggybacks any pending items addressed to this agent (see [Delivery](#delivery)).

### `wire_list`

Lightweight list of everyone currently on the wire. Designed to be called often.

```json
[
  {
    "agent_id": "abc-123",
    "name": "backend-agent",
    "description": "Rails API",
    "status": "Adding avatar_url to GET /users response",
    "working_dir": "/Users/moritz/project/api",
    "branch": "feat/avatar",
    "connected_since": "2026-04-07T14:30:00Z",
    "last_activity": "2026-04-07T14:35:22Z",
    "supports_push": true
  }
]
```

No `claude_md_summary` here — call `wire_describe` for that.

### `wire_describe`

Full project card for a single agent on the wire, including the CLAUDE.md summary.

```json
{ "agent": "backend-agent" }
```

### `wire_send`

Pass something to another agent on the wire. `to` accepts an agent name or `"*"` for everyone on the wire.

```json
{
  "to": "backend-agent",
  "kind": "note | request | question",
  "body": "I need an `avatar_url` field on GET /users/:id (string, nullable)",
  "priority": "normal | high"
}
```

- `note` — FYI, no response expected ("I just renamed the Button component")
- `request` — please do a thing ("please add avatar_url to the user response")
- `question` — please answer ("what's the exact shape of /users/:id now?")

agent-wire explicitly does not orchestrate work — `request` is a polite pointer, not a job assignment.

### `wire_read`

Pull unread items addressed to this agent, mark them read. Primarily a fallback for clients without channel push.

```json
{ "agent_id": "..." }
```

Claude Code clients shouldn't need this — items arrive via channel events.

### `wire_log`

Append to a shared decisions log on the wire. For things you want other agents (and future-you at the dashboard) to remember.

```json
{
  "agent_id": "...",
  "entry": "API contract: GET /users/:id now returns avatar_url (string, nullable)"
}
```

### `wire_log_read`

Read the shared log. Optional `since` timestamp filter.

### `wire_deregister`

Leave the wire. **The bridge calls this automatically on session exit** (stdio close, SIGINT, SIGTERM) — you don't need to call it yourself. Idempotent.

---

## Delivery

Two delivery paths. The daemon picks per recipient, based on what each agent's transport supports. Both paths stay entirely inside the daemon — no external transport, no outbound sockets.

### Push (Claude Code via Channels)

When the bridge attaches to Claude Code, it declares the `claude/channel` capability in its MCP `Server` constructor:

```ts
capabilities: {
  experimental: {
    'claude/channel': {},
    // Opt-in for internal permission relay between your own agents:
    // 'claude/channel/permission': {},
  },
  tools: { /* wire_* */ },
},
instructions:
  'You are on agent-wire, a private internal bus shared with other coding ' +
  'agents running on this machine. Items from other agents arrive as ' +
  '<channel source="agent-wire" from="..." kind="..." priority="...">…</channel>. ' +
  'Read them, act on them, and reply via the wire_send tool when appropriate.',
```

When another agent calls `wire_send` targeting this agent, the daemon pushes the item over its internal SSE connection to the bridge, which re-emits it as a `notifications/claude/channel` event. Claude Code surfaces it in the session as:

```
<channel source="agent-wire" from="backend-agent" kind="request" priority="normal">
please add avatar_url to the user response (string, nullable)
</channel>
```

Zero polling. The receiving agent reacts in the same tick.

**Research-preview caveats** (Claude Code 2.1.80+):
- Channels require `claude.ai` login (not API-key sessions).
- Custom channels aren't on the approved allowlist yet → users launch Claude with `--dangerously-load-development-channels server:agent-wire`.
- Team/Enterprise orgs must enable channels in org policy.
- The README documents all of this plainly, with a copy-pasteable launch command and a `wire-claude` wrapper that sets the flag for you.

### Pull (everyone else) + piggyback

For clients without channel support:

1. **`wire_read`** — explicit polling.
2. **Piggyback**: *every successful tool response* includes a `pending` array when the calling agent's identity is known (i.e. after `wire_register`). This covers all tools — `wire_status`, `wire_list`, `wire_describe`, `wire_send`, `wire_log`, `wire_log_read`, and even `wire_register` itself. An agent that never calls `wire_read` still receives pending items the next time it calls any wire tool. Also acts as a safety net for Claude Code if a channel event is ever dropped.

```json
// example wire_list response (any tool, not just wire_status)
{
  "ok": true,
  "data": [ /* ... */ ],
  "pending": [
    { "from": "backend-agent", "kind": "note", "body": "deployed new user schema" }
  ]
}
```

### Internal permission relay *(future, opt-in)*

Channels support `notifications/claude/channel/permission_request`. Between your own agents on the wire, this could be used so that Agent A's Bash/Write approval prompts are surfaced inside Agent B's session and approved there — local terminal dialog stays live in parallel, first answer wins.

This stays **entirely on the wire** — no external relay. But one of your agents being able to approve another's tool calls is a sharp knife: a confused or runaway agent could farm approvals from a complacent peer. So v1 ships with this off and spec'd as a future opt-in, per-agent-pair.

---

## Context publishing

On `wire_register`, the agent publishes a short project card so every other agent on the wire can understand the project without reading any files.

The card contains:

| Field | Source | Who fills it |
|---|---|---|
| `claude_md_summary` | `./CLAUDE.md` (+ `.claude/CLAUDE.md`, parent chain) | Agent summarizes to ≤10 bullets |
| `repo.{root,branch,remote}` | `git rev-parse`, `git branch --show-current`, `git remote` | Bridge auto-fills |
| `manifest.{type,name,key_deps}` | `package.json` / `Gemfile` / `pyproject.toml` / `Cargo.toml` / `go.mod` | Bridge auto-fills |

The bridge re-hashes CLAUDE.md on every `wire_status` call. If it changed, the context is flagged stale and the agent is nudged (via piggyback) to call `wire_register` again with a fresh summary.

Other agents see it via `wire_describe` or the dashboard. No file sync, no cross-project reads — everyone's on the same filesystem; the summary is just the shortcut.

**Boundary note**: agent-wire is local and single-user. All agents on the wire run as the same user on the same machine. The CLAUDE.md summary you publish stays inside the daemon's memory and is visible only to other agents you yourself have brought up on the wire.

---

## Dashboard

`http://127.0.0.1:4747/` serves a single-page live view of the wire. SSE-driven, zero build step, one HTML file with vanilla JS (or Preact + htm via CDN — still no bundler). It's both a selling point and a debugging tool. Like everything else, it only listens on loopback.

### Layout

**Topbar**
- `N agents on the wire · M items passed · K decisions logged · uptime Xh Ym`

**Left: Agents panel**
- One card per agent on the wire, color-coded (deterministic hash of name)
- Status dot: green (active <2min), yellow (idle), grey (dropped off)
- Name, role, current `wire_status` line
- `working_dir` · branch
- Connected since / last activity
- Unread / sent counts
- Click → expand to full project card (CLAUDE.md summary, manifest, repo info — the `wire_describe` payload)
- "Kick" button for manually dropping a stuck session from the wire

**Middle: Activity feed**

Chronological, live. Every wire event renders here, filterable by agent and event type, with a search box.

Events:
- `● frontend-agent joined the wire — Next.js frontend`
- `◆ frontend-agent: "Refactoring UserProfile..."` *(status change)*
- `→ frontend-agent → backend-agent: "I need avatar_url"` *(item passed, icon per kind)*
- `← backend-agent replied: "done, deploying"`
- `📋 backend-agent logged: "API contract change..."` *(wire_log)*
- `⚠ conflict: frontend-agent and backend-agent both touching src/types/user.ts` *(future, requires wire_watch_files)*
- `🔔 frontend-agent left the wire`

Every event has a "copy as JSON" affordance for debugging.

**Right: Shared log tab**

Only `wire_log` entries, markdown-rendered. The "decisions & contracts" stream — quiet, curated, re-readable. This is what you scroll back through a week later to remember why the API looks the way it does.

### Backing endpoints (loopback only)

- `GET /` — the SPA
- `GET /api/agents` — current agents snapshot
- `GET /api/agents/:name` — full describe
- `GET /api/log` — shared log
- `GET /api/events` — **SSE stream** of every wire event. The SPA subscribes once and live-updates everything.
- `POST /mcp` — internal tool dispatch (used by the bridge over loopback; not a standard MCP-over-HTTP endpoint)

All of these refuse non-loopback connections at the socket level.

### Out of scope for v1

Replay/time-scrubber, conflict map (needs `wire_watch_files`), light/dark toggle, auth. All easy adds later.

---

## Transport

### stdio bridge (all clients)

Every agent session spawns `agent-wire-bridge` as a stdio MCP subprocess. Any MCP client that supports stdio subprocesses works — Claude Code, Cursor, Windsurf, Codex, Continue, etc. Install once:

```bash
claude mcp add --scope user agent-wire -- npx -y agent-wire-bridge
# (other clients have their own mcp-add syntax; point them at the same binary)
```

The bridge:

1. On start, tries to reach the daemon at `127.0.0.1:4747`. If nothing's there, it **lazy-starts the daemon** as a detached background process with a pidfile at `~/.agent-wire/daemon.pid`. No manual daemon start. First session to launch wins the race; subsequent sessions just connect.
2. Opens a long-lived internal SSE connection to the daemon for push events.
3. Declares the `claude/channel` capability so the daemon can push events as `notifications/claude/channel` — **Claude Code only**. Other clients that don't implement the channel experimental capability receive items via pull (`wire_read`) and universal piggyback.
4. Auto-fills `repo` and `manifest` on `wire_register`.
5. Heartbeats the daemon every 10s.
6. On session exit (stdio close, SIGINT, SIGTERM), calls `wire_deregister` before shutting down.

---

## Setup

### 1. Add to Claude Code

```bash
claude mcp add --scope user agent-wire -- npx -y agent-wire-bridge
```

The daemon starts lazily the first time a session connects. Nothing else to run.

### 2. Launch Claude Code with the channel enabled

During the Channels research preview:

```bash
claude --dangerously-load-development-channels server:agent-wire
```

The bridge ships a `wire-claude` wrapper that does this for you, so you can just run `wire-claude`.

### 3. Add to your CLAUDE.md (global or per-project)

```markdown
## Agent Wire

You are connected to agent-wire, a private internal bus shared with
other coding agents running on this machine. Everything on the wire
stays local.

On session start:
- Call `wire_register` with a short role-based name (e.g. "frontend-agent"),
  a one-line description, and your `working_dir`.
- Read `./CLAUDE.md` (and any parent CLAUDE.md files), summarize them to at
  most 10 bullets covering stack, conventions, and current focus, and pass
  the summary as `context.claude_md_summary`.

While working:
- Before starting a task, call `wire_status` with a one-line description.
- Before starting work, call `wire_list` to see who else is on the wire.
  If an agent's project looks relevant, call `wire_describe <name>` for
  their full project card.
- Items from other agents arrive as `<channel source="agent-wire" ...>`
  tags in your context. Read them and react.
- When you change a shared contract (API, schema, types, config),
  broadcast via `wire_send` to `"*"` with kind `"note"`.
- When you need something from another agent, use `wire_send` with kind
  `"request"` or `"question"`.
- Log cross-agent decisions via `wire_log`.
```

### 4. Skip permission prompts (Claude Code)

By default Claude Code prompts for permission on every `wire_*` tool call. Add a wildcard allowlist to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__agent-wire__*"]
  }
}
```

### 5. Open the dashboard

```
http://127.0.0.1:4747/
```

---

## Tech stack

- **Runtime**: Node 20+. Not Bun — maximum `npx` reach and zero install friction.
- **Language**: TypeScript, compiled on publish.
- **Daemon**: Node `http` (or a tiny dep like `hono`), in-memory `Map` state, internal SSE endpoint for dashboard + bridges. Binds to `127.0.0.1` only.
- **Bridge**: `@modelcontextprotocol/sdk`, declares `claude/channel` capability, proxies MCP tool calls to the daemon over loopback HTTP, pipes daemon events into `notifications/claude/channel`.
- **Dashboard**: one HTML file, vanilla JS or Preact+htm via CDN, no bundler.
- **Deps**: `@modelcontextprotocol/sdk`, `zod`. That's it.

Published as a single npm package `agent-wire` with three bins:
- `agent-wire` → runs the daemon in the foreground (for `npx agent-wire` or debugging)
- `agent-wire-bridge` → runs the stdio bridge (spawned by MCP clients)
- `wire-claude` → launches Claude Code with `--dangerously-load-development-channels server:agent-wire` pre-set

---

## Data model

```ts
interface Agent {
  id: string                // UUID
  name: string              // "frontend-agent" (unique, auto-suffixed on collision)
  description: string
  working_dir: string
  status: string            // current task line
  connected_since: string   // ISO 8601
  last_activity: string     // ISO 8601
  supports_push: boolean    // true if the transport declared claude/channel
  context: {
    claude_md_summary?: string
    claude_md_hash?: string
    repo?: { root: string; branch: string; remote?: string }
    manifest?: { type: string; name: string; key_deps: string[] }
  }
}

interface WireItem {
  id: string
  from: string              // agent name
  to: string                // agent name or "*"
  kind: 'note' | 'request' | 'question'
  priority: 'normal' | 'high'
  body: string
  timestamp: string         // ISO 8601
  read: boolean
  delivered_push: boolean
}

interface LogEntry {
  id: string
  agent: string
  entry: string
  timestamp: string         // ISO 8601
}
```

All in memory. Process dies → state is gone.

---

## Non-goals

- **Persistence.** Agents are ephemeral. No DB.
- **Auth.** Loopback, single user, single process tree. Not a boundary that needs defending in v1.
- **External transport of any kind.** No webhooks, no chat bridges, no remote relay, no LAN. If you want those, you want a different tool.
- **Task orchestration.** agent-wire doesn't assign work, manage dependencies, or decide priority. `request` is a polite pointer, not a job assignment.
- **File sync.** Same filesystem already.
- **LLM work inside the daemon.** The daemon never summarizes, never reasons. All intelligence stays with the agents.

---

## Future ideas

- **Internal permission relay** via `claude/channel/permission` — approve Bash/Write calls from another on-wire agent's session. Strictly between agents on the wire. Opt-in per agent pair.
- **`wire_watch_files`** — agents declare which globs they're touching. Dashboard shows conflict map.
- **`wire_ask` with blocking wait** — sync question/answer with short timeout.
- **`wire_board_get` / `wire_board_patch`** — a single shared mutable markdown doc all agents can read and patch. The "whiteboard".
- **Auto-naming** from `working_dir` / CLAUDE.md so `wire_register` can be called with zero args.
- **Replay / time scrubber** in the dashboard.
- **Richer liveness** — idle detection, auto-kick.
