import { describe, expect, it } from "vitest";
import { createFeedState } from "../public/feed-client.js";

function makeUpdate(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "u1",
    roomId: "demo-room",
    seq: 1,
    content: "hello",
    createdAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("feed client dedup + ordering", () => {
  it("ignores an update that arrives twice through overlapping delivery paths", () => {
    const state = createFeedState();
    const update = makeUpdate();

    // Same update delivered once via "history" and once via a live push
    // (e.g. it arrived just as reconnection history was being replayed).
    state.applyHistory([update]);
    const wasNew = state.applyLive(update);

    expect(wasNew).toBe(false);
    expect(state.getMessages()).toHaveLength(1);
  });

  it("orders messages by seq regardless of arrival order", () => {
    const state = createFeedState();

    state.applyLive(makeUpdate({ id: "u2", seq: 2, content: "second" }));
    state.applyHistory([makeUpdate({ id: "u1", seq: 1, content: "first" })]);
    state.applyLive(makeUpdate({ id: "u3", seq: 3, content: "third" }));

    expect(state.getMessages().map((u: any) => u.content)).toEqual(["first", "second", "third"]);
  });

  it("tracks the highest seq seen as the resume cursor", () => {
    const state = createFeedState();
    state.applyHistory([
      makeUpdate({ id: "u1", seq: 1 }),
      makeUpdate({ id: "u2", seq: 2 }),
    ]);
    expect(state.getLastSeq()).toBe(2);

    state.applyLive(makeUpdate({ id: "u3", seq: 3 }));
    expect(state.getLastSeq()).toBe(3);

    // A late/duplicate arrival with a lower seq must not roll the cursor back.
    state.applyLive(makeUpdate({ id: "u2-dup", seq: 2, content: "late duplicate" }));
    expect(state.getLastSeq()).toBe(3);
  });
});
