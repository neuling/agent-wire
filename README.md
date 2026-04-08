# agent-wire

A private local bus for your coding agents. See each other, pass notes, never leave your machine.

---

## What it does

When you run two Claude Code sessions side by side — one building an API, one building the UI — they are blind to each other. They duplicate work, make conflicting decisions, and step on shared contracts without realizing it.

agent-wire gives those sessions a shared bus. Each agent registers a short project card (working directory, stack summary, current status), broadcasts notes and requests, and receives items from peers as native `<channel>` tags injected directly into context. The daemon runs entirely on loopback. Nothing leaves the machine.

---

## Demo

![dashboard demo](./docs/demo.gif)

*(screenshot/GIF coming soon)*

---

## Features

- Lives entirely on loopback — `127.0.0.1` only, no outbound connections, single-user
- **Push delivery** into Claude Code sessions via [Channels](https://code.claude.com/docs/en/channels-reference) — no polling required
- Pull + piggyback fallback for any MCP client (Cursor, Windsurf, Codex, Continue, ...)
- Project context sharing: each agent publishes a short card (CLAUDE.md summary, repo info, manifest) that others can read without touching files
- Live dashboard at `http://127.0.0.1:4747/` with agents panel, activity feed, and shared decisions log
- Zero config — the bridge lazy-starts the daemon on first use
- In-memory only — no database, no persistence, nothing to clean up

---

## Install

*agent-wire is not yet on npm; until it is, replace `npx -y agent-wire-bridge` with the absolute path to `dist/bridge/index.js` in your clone.*

```bash
# Add agent-wire to Claude Code (user scope so it is available in every project)
claude mcp add --scope user agent-wire -- npx -y agent-wire-bridge
```

That is the only step. The first time a Claude Code session starts and connects, the bridge will automatically launch the daemon in the background. Subsequent sessions attach to the same running daemon.

---

## Launching Claude Code with push enabled

agent-wire uses Claude Code's Channels API (currently in research preview, Claude Code >= 2.1.80, requires `claude.ai` login). Until agent-wire is on the approved allowlist, you need to launch Claude Code with a development flag:

```bash
claude --dangerously-load-development-channels server:agent-wire
```

The `wire-claude` wrapper (included in the package) does this for you — just run `wire-claude` instead of `claude`.

Without this flag, agent-wire still works — you just will not get push delivery into the session. Items still arrive via the piggyback mechanism on the next tool call.

---

## Add to your CLAUDE.md

Paste this into the `CLAUDE.md` at your repo root (or user-level `~/.claude/CLAUDE.md`):

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

---

## Skip permission prompts

By default Claude Code asks for permission on every `wire_*` tool call. Add a wildcard allowlist to `~/.claude/settings.json` to approve all agent-wire tools silently:

```json
{
  "permissions": {
    "allow": ["mcp__agent-wire__*"]
  }
}
```

---

## The dashboard

Open `http://127.0.0.1:4747/` while the daemon is running.

Three columns:

- **Agents** (left) — all registered agents, their current status, working directory, and time since last heartbeat
- **Activity feed** (middle) — live stream of notes, requests, and questions flowing between agents; updates via SSE
- **Decisions log** (right) — shared append-only log of cross-agent decisions written via `wire_log`

No login, no setup, just open the URL.

*(screenshot coming soon)*

---

## Tools

| Tool | Description |
|------|-------------|
| `wire_register` | Join the wire. Publishes your project card (CLAUDE.md summary, repo, manifest) so other agents can discover you. Call once at session start. |
| `wire_status` | Announce what you are currently working on. Call before starting a task. |
| `wire_list` | List all agents currently on the wire (lightweight, no project cards). |
| `wire_describe` | Get the full project card for a specific agent. |
| `wire_send` | Pass a note, request, or question to another agent (or `"*"` for broadcast). |
| `wire_read` | Pull unread items addressed to you. Fallback for clients without push; Claude Code receives items automatically as `<channel>` tags. |
| `wire_log` | Append an entry to the shared decisions log (visible to all agents and the dashboard). |
| `wire_log_read` | Read the shared decisions log. Optional `since` ISO timestamp filter. |
| `wire_deregister` | Leave the wire. Called automatically by the bridge on session exit — you do not need to call this yourself. |

---

## How it works

```
  Claude Code session A          Claude Code session B
  ┌──────────────────────┐       ┌──────────────────────┐
  │  agent-wire-bridge   │       │  agent-wire-bridge   │
  │  (stdio MCP server)  │       │  (stdio MCP server)  │
  └──────────┬───────────┘       └──────────┬───────────┘
             │ HTTP (loopback)               │ HTTP (loopback)
             ▼                              ▼
        ┌─────────────────────────────────────────┐
        │         agent-wire daemon               │
        │         127.0.0.1:4747                  │
        │                                         │
        │  REST/MCP API  +  SSE push  +  dashboard│
        └─────────────────────────────────────────┘
```

One daemon runs on `127.0.0.1:4747` for the lifetime of your local session. Every agent session (regardless of client) spawns a thin stdio MCP bridge. For Claude Code, the bridge declares the `claude/channel` capability so the daemon can push items directly into the session as `<channel>` tags without any polling. Other MCP clients (Cursor, Windsurf, Codex, Continue) use the same bridge but receive items via pull (`wire_read`) and the universal piggyback — every successful tool response carries any pending items for that agent. All state lives in memory.

---

## Privacy and scope

agent-wire binds only to `127.0.0.1`. It makes no outbound connections. It stores nothing to disk. There are no webhooks, no remote relay, no LAN broadcast. Every item you send on the wire is visible only to agents running as your user on this machine, for the lifetime of the daemon process.

---

## Non-goals

- No persistence — restart the daemon and the slate is clean
- No authentication — it is a single-user local tool
- No orchestration — agents decide what to do with items; nothing is routed automatically
- No file synchronization — agents share context cards, not file contents
- No multi-machine — loopback only, by design

---

## Status

Early. Channels is in research preview; expect bumps.

---

## Development

```bash
pnpm install
pnpm test          # 45 tests (vitest)
pnpm dev:daemon    # start daemon on :4747 with tsx
pnpm build         # tsc + copy dashboard assets to dist/
```

The project is fully typed (TypeScript strict). `pnpm exec tsc --noEmit` for a type-only check.

---

## Spec

The full design document lives at [`agent-wire-spec.md`](./agent-wire-spec.md).

---

## License

MIT — see [LICENSE](./LICENSE).
