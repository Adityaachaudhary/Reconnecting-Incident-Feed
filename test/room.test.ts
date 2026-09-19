import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

// These tests call the Durable Object's methods directly (no real
// websocket), exercising exactly the logic the problem brief calls out as
// easy to get wrong: sequence assignment and cursor-based replay.

describe("IncidentRoom - publish & sequencing", () => {
  it("assigns strictly increasing sequence numbers per room", async () => {
    const id = env.INCIDENT_ROOM.idFromName("room-seq-test");
    const stub = env.INCIDENT_ROOM.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      const first = await instance.publishUpdate("first incident note");
      const second = await instance.publishUpdate("second incident note");
      const third = await instance.publishUpdate("third incident note");

      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
      expect(third.seq).toBe(3);

      // ids must be unique even though content/timestamps could collide
      const ids = new Set([first.id, second.id, third.id]);
      expect(ids.size).toBe(3);
    });
  });
});

describe("IncidentRoom - history replay from a cursor", () => {
  it("returns only updates strictly after the given cursor", async () => {
    const id = env.INCIDENT_ROOM.idFromName("room-replay-test");
    const stub = env.INCIDENT_ROOM.get(id);

    await runInDurableObject(stub, async (instance: any) => {
      await instance.publishUpdate("a");
      await instance.publishUpdate("b");
      await instance.publishUpdate("c");

      const fromStart = await instance.getHistorySince(0);
      expect(fromStart.map((u: any) => u.content)).toEqual(["a", "b", "c"]);

      const afterFirst = await instance.getHistorySince(1);
      expect(afterFirst.map((u: any) => u.content)).toEqual(["b", "c"]);

      const afterAll = await instance.getHistorySince(3);
      expect(afterAll).toEqual([]);
    });
  });

  it("keeps rooms independent of one another", async () => {
    const idA = env.INCIDENT_ROOM.idFromName("room-a");
    const idB = env.INCIDENT_ROOM.idFromName("room-b");
    const stubA = env.INCIDENT_ROOM.get(idA);
    const stubB = env.INCIDENT_ROOM.get(idB);

    await runInDurableObject(stubA, async (instance: any) => {
      await instance.publishUpdate("only in room a");
    });

    await runInDurableObject(stubB, async (instance: any) => {
      const history = await instance.getHistorySince(0);
      expect(history).toEqual([]);
    });
  });
});
