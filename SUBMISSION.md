# SUBMISSION.md

## What happens if a client disconnects immediately after sending an update?

The publish itself is unaffected: `webSocketMessage` runs inside the
Durable Object regardless of whether the sending socket is still open by
the time `publishUpdate` finishes — the update is written to durable
storage and assigned a `seq` before broadcast is attempted. Broadcasting
to a now-closed socket is wrapped in a `try/catch` in `broadcast()` and
simply skipped for that socket; every *other* connected client still
receives it normally.

The disconnected client itself does not lose its own update: when it
reconnects, it sends `hello` with whatever `since` cursor it had *before*
publishing. Since the update was durably stored before the (attempted)
broadcast, it comes back as part of history on reconnect like any other
missed update. From that client's point of view, it just looks like a
normal missed-update recovery — there is no special case for "the update
I sent right as I disconnected."

## How would multiple backend instances share and order events?

Today, correctness relies on a Durable Object being a single-threaded,
single-instance authority per room — that's what makes "assign the next
`seq`" race-free without extra locking. Scaling to multiple backend
*instances* only really makes sense as multiple *rooms* (each room's DO
already runs wherever Cloudflare places it, which is a form of horizontal
scaling across rooms for free).

If a single room's traffic ever needed to be spread across more than one
process, the ordering authority would have to become explicit and
external — a real sequencer (e.g. a single-writer log per room, similar
in spirit to what Kafka does per-partition) that every instance appends
to and reads from, with instances only fanning out to sockets they own
and forwarding publishes to the sequencer rather than assigning `seq`
themselves. That's meaningfully more infrastructure, which is why this
prototype leans on the DO's natural single-writer property instead of
building a distributed sequencer for a scale this exercise doesn't need.

## How would you prevent an unbounded history replay?

Two changes, in order of how soon they'd be needed:

1. **Cap what a single `hello` can request.** `getHistorySince` currently
   returns everything after the cursor with no limit. A pending-forever
   client (or a bug sending `since: 0` against a room with years of
   history) could ask for an enormous payload in one message. The fix is
   a page size (e.g. `list({ start, limit: 500 })`) plus a `hasMore` flag
   in the `history` message, with the client requesting the next page
   ( `hello` again with an updated `since` ) until caught up, rather than
   the server ever answering with an unbounded list.

2. **Retention / compaction.** Right now history is kept forever. A
   production version would need either a retention window (drop/archive
   updates older than N days, since an incident feed's active life is
   probably measured in hours-to-days) or periodic compaction into a
   summary, so `getHistorySince(0)` from a client that's been offline for
   months doesn't mean replaying the room's entire lifetime.

## What would you monitor in production?

- **Reconnect rate and reconnect-attempt distribution per client** — a
  client that's stuck at attempt 6 repeatedly (i.e. hitting the backoff
  cap and giving up over and over) is a leading indicator of either a
  real outage or a client-side bug, before users start complaining.
- **History replay size per reconnect** — if clients are routinely
  replaying thousands of updates, that's a signal the paging/retention
  work above is overdue, not just a hypothetical.
- **Durable Object storage size and `list()` latency per room** — the
  cursor-replay query's cost grows with room history size; this is the
  concrete metric that would tell you when unbounded replay (the
  question above) has gone from theoretical to actually happening.
- **Broadcast failures** (the `catch` in `broadcast()`) — currently
  silent by design (the disconnect event handles it), but a spike here
  independent of reconnect activity would suggest something wrong with
  fan-out itself, not just individual flaky clients.
- **WebSocket connection count per room vs. Durable Object CPU/wall time**
  — the practical ceiling on "how many clients can one room support" is
  this, and it's the number that tells you if/when a single-DO-per-room
  design needs to change.
