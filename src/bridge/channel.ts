import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { DaemonClient } from './daemonClient.js'

/**
 * Subscribe to the daemon's event stream and re-emit incoming items
 * addressed to `getSelfName()` as MCP channel notifications.
 *
 * Returns a disposer.
 */
export function startChannelPump(
  mcp: Server,
  daemon: DaemonClient,
  getSelfName: () => string | null,
): () => void {
  return daemon.subscribeEvents(
    evt => {
      const self = getSelfName()
      if (!self) return
      if (evt?.type !== 'item_sent') return
      const item = evt.item
      const isForMe =
        item.to === self ||
        (item.to === '*' && item.from !== self)
      if (!isForMe) return
      // Cast to any: notifications/claude/channel is an experimental method
      // not in the SDK's ServerNotification union, but assertNotificationCapability
      // has a fall-through default that allows unknown methods without throwing.
      ;(mcp.notification as (n: any) => Promise<void>)({
        method: 'notifications/claude/channel',
        params: {
          content: String(item.body ?? ''),
          meta: {
            from: String(item.from ?? ''),
            kind: String(item.kind ?? ''),
            priority: String(item.priority ?? 'normal'),
          },
        },
      }).catch(() => { /* swallow — channel push is best-effort */ })
    },
    () => { /* SSE drop — bridge keeps running, daemon will be re-probed on next heartbeat */ },
  )
}
