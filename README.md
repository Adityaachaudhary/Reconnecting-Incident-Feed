# Reconnecting Incident Feed

A minimal shared incident feed: two or more browser clients connect to the
same "room", see each other's updates live, and — the actual point of the
exercise — recover cleanly from a dropped connection: missed updates are
replayed on reconnect, with no duplicates and a deterministic order.

## Stack

- **Cloudflare Workers** — HTTP entry point / router.
- **Durable Objects** — one instance per room. Holds durable history and
  fans out live updates over WebSockets (using the hibernatable WebSocket
  API, `ctx.acceptWebSocket` / `ctx.getWebSockets`, so the runtime tracks
  connected sockets — no manual in-memory `Set` to keep in sync).
- **Workers Static Assets** — serves the plain HTML/JS client from the same
  Worker (`[assets]` in `wrangler.toml`), so there's one deployable unit.
- **Vitest + `@cloudflare/vitest-pool-workers`** — tests run against the
  real `workerd` runtime, including real WebSocket connections opened via
  `SELF.fetch(...)` — not a mocked transport.

No framework on the client — a couple of small JS modules and one HTML
page, per the brief ("this is not a visual-design exercise").

## Project layout

```
src/
  index.ts        Worker entry point: routes /api/rooms/:id/ws to the
                   right Durable Object, everything else to static assets
  room.ts          IncidentRoom Durable Object: storage, sequencing,
                   websocket handlers, broadcast
  types.ts         Shared Update / protocol message types
public/
  index.html       The page
  feed-client.js   Pure state logic: dedup + ordering (no DOM, no WS —
                   this is what's unit tested directly)
  app.js           DOM + WebSocket wiring: connect, render, reconnect
                   with bounded backoff
test/
  room.test.ts             DO sequencing + cursor-based replay
  live-broadcast.test.ts   Real websockets: live delivery + missed-update
                           replay on reconnect
  feed-client.test.ts      Dedup / ordering / cursor logic in isolation
```

## Setup

Requires Node 18+ and a Cloudflare account (free tier is enough) for
actual deployment. Everything below works locally without one, except
`npm run deploy`.

```bash
npm install
```

## Run locally

```bash
npm run dev
```

This starts `wrangler dev`, which runs the Worker and Durable Object
locally. Open the printed local URL (e.g. `http://localhost:8787`) in two
browser tabs/windows, using the same room name in both (default
`demo-room`), to see live updates move between them.

### Simulating a dropped connection

There's no special "offline mode" flag needed for this exercise — a
websocket disconnect is a websocket disconnect. Use your browser's
devtools:

- Chrome/Edge: Network tab → throttling dropdown → **Offline**.
- Or just close the laptop lid / put the machine to sleep and wake it —
  the socket will drop and the client will show `reconnecting`.

Re-enable the network (or switch throttling back) and the client
reconnects automatically, with bounded exponential backoff (1s, 2s, 4s,
8s, 16s, capped at 30s, giving up after 6 attempts with a manual
"Reconnect" button as the fallback).

To simulate a **failing backend** rather than a dropped client
connection, stop the `wrangler dev` process while a client is connected —
its socket will close, and it will go through the same reconnect flow
once you restart `npm run dev`.

## Test

```bash
npm test
```

Runs all three suites against the real Workers runtime, including actual
WebSocket connections opened through the Worker's fetch handler (not a
mock). No paid services or external network calls are involved.

```bash
npm run typecheck
```

## Deploy

```bash
npx wrangler login   # one-time, opens a browser to authorize your account
npm run deploy
```

## Design decisions (also see `SUBMISSION.md`)

**Why WebSockets, and why Durable Objects specifically.** A Durable
Object gives a single, consistently-ordered place to assign sequence
numbers and hold durable history for a room, plus native, low-effort
WebSocket hosting (no separate pub/sub infra needed for this scale). The
hibernatable WebSocket API means the DO doesn't need to manually track
"which sockets are open" — `ctx.getWebSockets()` is the source of truth,
which removes a whole class of "socket removed from array but didn't
actually close" bugs.

**How the client identifies where to resume from.** Every stored update
has a server-assigned, strictly increasing `seq` (per room). The client
tracks the highest `seq` it has ever applied and sends it as `since` in
a `hello` message on every connect — including reconnects. The server
replays only `seq > since` from durable storage before switching that
socket over to live broadcast.

**Who owns ordering.** The Durable Object, exclusively. `seq` is assigned
server-side at the moment an update is durably stored — never generated
or reordered client-side. Storage keys are zero-padded so the storage
layer's native lexicographic ordering matches numeric `seq` ordering,
which is also what makes an efficient cursor-based `list({ start })`
query possible.

**Where dedup happens.** Client-side, keyed by the update's stable `id`
(see `public/feed-client.js`). This is deliberate: an update can
legitimately arrive twice from the *server's* point of view (e.g. it's
in the history payload, and — if the client is slow to process
messages — a live copy could theoretically be queued right behind it).
Rather than trying to make the server prove it never double-sends,
the client is the simplest, always-correct place to make "each logical
update shown once" true.

**Why history is sent before switching to live push (not interleaved).**
On `hello`, the DO computes `getHistorySince(since)` from storage and
sends it in one `history` message; only after that do subsequent
`publish` events go out as `update` messages to that same socket. Because
both history reads and broadcasts happen synchronously within the DO's
single-threaded execution model, there's no window where a live update
could be constructed and sent to a socket before that socket's own
history reply is sent — sequential execution is easier to reason about
than trying to buffer-and-merge two concurrent streams.

**Reconnect bounding.** Exponential backoff (1s → 30s cap), capped at 6
attempts, then a manual "Reconnect" button. This avoids both a tight
retry loop hammering the server and an unbounded retry loop running
forever in a background tab.
