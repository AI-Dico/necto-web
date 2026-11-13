//
// Copyright (c) 2026 AI-Dico
//

export type CdpEventHandler = (method: string, params: Record<string, unknown>) => void;

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

/// One DevTools socket to one page. Commands resolve with their `result`; events go to
/// `onEvent`. A closed socket rejects everything still waiting, so no caller hangs.
export class CdpSession {
  private socket: WebSocket | null = null;
  private nextID = 1;
  private readonly pending = new Map<number, Pending>();

  onEvent: CdpEventHandler = () => {};
  onClose: (reason: string) => void = () => {};

  constructor(readonly url: string) {}

  connect(timeoutMilliseconds = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let opened = false;

      const timer = setTimeout(() => {
        if (opened) return;
        socket.close();
        reject(new Error("Timed out opening the DevTools socket."));
      }, timeoutMilliseconds);

      socket.addEventListener("open", () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      });

      socket.addEventListener("message", (event) => this.receive(String(event.data)));

      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        const reason = event.reason || `closed (${event.code})`;
        for (const waiting of this.pending.values()) waiting.reject(new Error(reason));
        this.pending.clear();
        this.socket = null;
        if (opened) this.onClose(reason);
        else
          reject(
            new Error(
              // 1006 before opening is what Chrome's origin check looks like from here.
              `Could not open the DevTools socket (${event.code}). ` +
                "Start the browser with --remote-allow-origins='*'.",
            ),
          );
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected."));
    }
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket?.close();
  }

  private receive(data: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      const error = message.error as { message?: string } | undefined;
      if (error) waiting.reject(new Error(error.message ?? "DevTools error"));
      else waiting.resolve((message.result as Record<string, unknown>) ?? {});
      return;
    }

    if (typeof message.method === "string") {
      this.onEvent(message.method, (message.params as Record<string, unknown>) ?? {});
    }
  }
}
