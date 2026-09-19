import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

// End-to-end test through the real Worker fetch handler + Durable Object,
// using actual WebSocket connections (no mocking of the transport layer).

async function connectToRoom(roomId: string): Promise<WebSocket> {
  const response = await SELF.fetch(`https://example.com/api/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = response.webSocket;
  if (!ws) {
    throw new Error("Worker did not return a websocket for an upgrade request");
  }
  ws.accept();
  return ws;
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for a message")), 5000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(event.data as string));
      },
      { once: true }
    );
  });
}

describe("live broadcast across two connected clients", () => {
  it("delivers a published update to another client without it publishing anything itself", async () => {
    const roomId = `live-${Math.random().toString(36).slice(2)}`;
    const clientA = await connectToRoom(roomId);
    const clientB = await connectToRoom(roomId);

    clientA.send(JSON.stringify({ type: "hello", since: 0 }));
    clientB.send(JSON.stringify({ type: "hello", since: 0 }));
    await waitForMessage(clientA); // initial (empty) history for A
    await waitForMessage(clientB); // initial (empty) history for B

    const bReceivesUpdate = waitForMessage(clientB);
    clientA.send(JSON.stringify({ type: "publish", content: "incident update from A" }));

    const received = await bReceivesUpdate;
    expect(received.type).toBe("update");
    expect(received.update.content).toBe("incident update from A");
    expect(received.update.seq).toBe(1);

    clientA.close();
    clientB.close();
  });

  it("replays missed updates to a client that reconnects with a cursor", async () => {
    const roomId = `replay-${Math.random().toString(36).slice(2)}`;
    const publisher = await connectToRoom(roomId);
    publisher.send(JSON.stringify({ type: "hello", since: 0 }));
    await waitForMessage(publisher);

    // Publish while the "other" client is not connected at all.
    const firstAck = waitForMessage(publisher); // publisher also gets the broadcast
    publisher.send(JSON.stringify({ type: "publish", content: "missed while offline" }));
    await firstAck;

    // Now a client "reconnects" already knowing seq 0 (never saw anything).
    const reconnecting = await connectToRoom(roomId);
    const historyPromise = waitForMessage(reconnecting);
    reconnecting.send(JSON.stringify({ type: "hello", since: 0 }));
    const history = await historyPromise;

    expect(history.type).toBe("history");
    expect(history.updates).toHaveLength(1);
    expect(history.updates[0].content).toBe("missed while offline");

    publisher.close();
    reconnecting.close();
  });
});
