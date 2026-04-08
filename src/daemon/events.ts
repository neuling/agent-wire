import { WireEvent } from './types.js'

type Listener = (e: WireEvent) => void

export class EventBus {
  private listeners = new Set<Listener>()
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(e: WireEvent) {
    for (const fn of this.listeners) fn(e)
  }
}
