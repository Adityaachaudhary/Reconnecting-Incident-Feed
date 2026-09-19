import type { ClientMessage, ServerMessage, Update } from "./types";

export interface Env {
  INCIDENT_ROOM: DurableObjectNamespace;
}

// Durable Object = one incident room.
//
// Responsibilities (kept deliberately separate):
//   - durable history (DurableObjectStorage): source of truth, survives eviction/restart
//   - sequencing: server assigns `seq`, never the client -> no ordering ambiguity
//   - live fan-out: broadcast to whatever websockets are currently attached
//
// Uses the hibernatable websocket API (ctx.acceptWebSocket / ctx.getWebSockets)
// so the set of connected sockets does not need to be tracked manually in
// memory — the runtime tracks it, including across hibernation.
export class IncidentRoom implements DurableObject {
  private ctx: DurableObjectState;
  private roomId = "unknown";

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/api\/rooms\/([a-zA-Z0-9_-]+)\/ws$/);
    if (match) {
      this.roomId = match[1];
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a websocket upgrade request", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    let parsed: ClientMessage;
    try {
      const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
      parsed = JSON.parse(text);
    } catch {
      this.sendTo(ws, { type: "error", message: "Message was not valid JSON" });
      return;
    }

    if (parsed.type === "hello") {
      const since = typeof parsed.since === "number" && parsed.since >= 0 ? parsed.since : 0;
      const history = await this.getHistorySince(since);
      this.sendTo(ws, { type: "history", updates: history });
      return;
    }

    if (parsed.type === "publish") {
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (!content) {
        this.sendTo(ws, { type: "error", message: "content must be a non-empty string" });
        return;
      }
      const update = await this.publishUpdate(content);
      this.broadcast({ type: "update", update });
      return;
    }

    this.sendTo(ws, { type: "error", message: "Unknown message type" });
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Nothing to do: the runtime removes closed sockets from
    // ctx.getWebSockets() automatically. Durable history is unaffected.
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    // Same as close — no in-memory client list to clean up ourselves.
  }

  // --- Core logic below is intentionally callable directly (without a real
  // websocket) so it can be unit tested in isolation. ---

  async publishUpdate(content: string): Promise<Update> {
    const previousSeq = (await this.ctx.storage.get<number>("seq")) ?? 0;
    const seq = previousSeq + 1;
    const update: Update = {
      id: crypto.randomUUID(),
      roomId: this.roomId,
      seq,
      content,
      createdAt: new Date().toISOString(),
    };

    // Persist the counter and the message together conceptually; order
    // matters less than the fact both are durable before we broadcast.
    await this.ctx.storage.put(this.storageKey(seq), update);
    await this.ctx.storage.put("seq", seq);
    return update;
  }

  async getHistorySince(sinceSeq: number): Promise<Update[]> {
    const list = await this.ctx.storage.list<Update>({
      prefix: "msg::",
      start: this.storageKey(sinceSeq + 1),
    });
    return Array.from(list.values());
  }

  broadcast(payload: ServerMessage): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // A dead socket here just means that client will notice on its own
        // (close/error event) and go through the normal reconnect flow.
      }
    }
  }

  private sendTo(ws: WebSocket, payload: ServerMessage): void {
    ws.send(JSON.stringify(payload));
  }

  // Zero-padded so storage.list()'s lexicographic ordering matches numeric
  // seq ordering, and so `start` can be used as a resume cursor.
  private storageKey(seq: number): string {
    return `msg::${seq.toString().padStart(10, "0")}`;
  }
}
