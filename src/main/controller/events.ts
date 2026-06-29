import type { ServerResponse } from 'http'
import type { ControllerEvent } from './types'

// Phase 35: a tiny in-process SSE hub. It only ever emits the safe event shapes
// declared in ControllerEvent — never prompts, terminal output, or secrets.

class ControllerEventHub {
  private clients = new Set<ServerResponse>()

  addClient(res: ServerResponse): void {
    this.clients.add(res)
    res.on('close', () => this.clients.delete(res))
  }

  count(): number {
    return this.clients.size
  }

  emit(event: ControllerEvent): void {
    if (this.clients.size === 0) return
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(payload)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
  }
}

export const controllerEvents = new ControllerEventHub()
