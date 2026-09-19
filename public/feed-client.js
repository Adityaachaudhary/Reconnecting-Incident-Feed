// Pure state logic for the incident feed client. Deliberately has no DOM
// or WebSocket dependency so it can be unit tested directly.
//
// Dedup rule: an update's `id` is the identity. The same update can arrive
// via the initial history load, a missed-update replay after reconnect, or
// a live push — whichever path gets there first wins, later arrivals of the
// same id are ignored. Ordering is always by server-assigned `seq`, never
// arrival order.

export function createFeedState() {
  const byId = new Map();
  let lastSeq = 0;

  function upsert(update) {
    if (byId.has(update.id)) {
      return false; // already seen via another delivery path — ignore
    }
    byId.set(update.id, update);
    if (update.seq > lastSeq) {
      lastSeq = update.seq;
    }
    return true;
  }

  return {
    // Applies a batch of updates (e.g. from a "history" message).
    applyHistory(updates) {
      let added = 0;
      for (const update of updates) {
        if (upsert(update)) added += 1;
      }
      return added;
    },
    // Applies a single live update. Returns whether it was new.
    applyLive(update) {
      return upsert(update);
    },
    // The resume cursor to send as `since` on (re)connect.
    getLastSeq() {
      return lastSeq;
    },
    // All known updates, deterministically ordered by seq.
    getMessages() {
      return Array.from(byId.values()).sort((a, b) => a.seq - b.seq);
    },
  };
}
