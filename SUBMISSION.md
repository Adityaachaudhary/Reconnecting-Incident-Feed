# Product Engineering Challenge Submission

## Candidate

- **Name:** Aditya Chaudhary
- **Email:** <adityaprakash.280102@gmail.com>
- **GitHub:** https://github.com/Adityaachaudhary
- **Selected problem:** Reconnecting Incident Feed
- **Demo video:** <https://www.loom.com/share/c9ce5abe3d334392b0b096f7c65425b3>

---

## Run the project

### Prerequisites

- Node.js 18+
- A Cloudflare account (free tier is sufficient) — only needed for `npm run deploy`; everything else runs locally without one

No secret environment variables are required to run locally. For deployment, `wrangler login` handles auth via browser OAuth — no tokens to set manually.

### Setup

```bash
npm install
```

### Run locally

```bash
npm run dev
```

Opens a local Worker + Durable Object at `http://localhost:8787`.

### Trigger the success scenario

1. Open `http://localhost:8787` in two browser tabs, using the same room name (default: `demo-room`).
2. Type a message in one tab and press Enter — it appears in both tabs immediately.

### Trigger the failure / recovery scenario

1. With both tabs open and connected, open DevTools in one tab → Network tab → throttling dropdown → **Offline**.
2. Publish a few messages from the *other* tab (the still-connected one).
3. Switch the offline tab back to **Online** (or No throttling).
4. The disconnected tab reconnects automatically (with bounded exponential backoff), sends `hello` with its last known `seq` cursor, and the server replays only the missed updates — no duplicates, correct order.

Alternatively: stop the `wrangler dev` process while a client is connected, then restart it. The client goes through the same reconnect flow.

---

## Run the tests

```bash
npm test
```

Runs all three suites against the real `workerd` runtime via `@cloudflare/vitest-pool-workers`. No paid services or external network calls required.

```bash
npm run typecheck
```

---

## Acceptance scenarios and verification

| Scenario | Status |
|---|---|
| Two clients in the same room see each other's updates live | ✅ Complete |
| Client reconnects after a dropped connection and replays missed updates | ✅ Complete |
| No duplicate messages after reconnect | ✅ Complete |
| Deterministic ordering (server-assigned `seq`, not arrival order) | ✅ Complete |
| Bounded exponential backoff (1s → 30s cap, 6 attempts, then manual button) | ✅ Complete |
| Room state is isolated — switching rooms clears the feed | ✅ Complete |
| Room names are sanitised to match the server's routing regex | ✅ Complete |

### Benchmark / verification command

```bash
npm test
```

### Observed result

All 3 test suites pass (room sequencing, live broadcast + missed-update replay via real WebSockets, feed-client dedup/ordering logic). No mismatches observed.

### Failure / recovery scenario (video)

The video shows:
1. Two tabs connected to `demo-room`.
2. One tab taken offline via DevTools → Network → Offline.
3. Several messages published from the online tab.
4. The offline tab brought back online — it reconnects, replays exactly the missed messages, and the feed matches the online tab with no duplicates.

To reproduce: follow the steps in "Trigger the failure / recovery scenario" above.

---

## Architecture and data flow

```
Browser Tab A          Cloudflare Worker (src/index.ts)
     |                        |
     |-- WebSocket upgrade --> |-- matches /api/rooms/:id/ws
     |                        |-- routes to IncidentRoom DO
     |                        |
     |              IncidentRoom Durable Object (src/room.ts)
     |                        |
     |<-- history (replay) --- |  on "hello": reads storage.list({ start: cursor })
     |<-- update (live) ------ |  on "publish": writes to storage, broadcasts to all sockets
     |                        |
Browser Tab B <-- update ---- |  same broadcast reaches all ctx.getWebSockets()
```

**Components:**

- `src/index.ts` — thin HTTP router. Matches the WebSocket upgrade path and forwards to the right DO; everything else falls through to static assets.
- `src/room.ts` (`IncidentRoom`) — the single authority per room. Assigns `seq`, persists updates to Durable Object storage with zero-padded keys (so lexicographic order = numeric order), and fans out to connected sockets via the hibernatable WebSocket API.
- `public/feed-client.js` — pure state module (no DOM, no WebSocket). Owns dedup (by `id`) and ordering (by `seq`). Tested directly without a browser.
- `public/app.js` — DOM + WebSocket wiring. Manages connect/reconnect lifecycle, sends `hello` with the current cursor on every (re)connect, and delegates all state logic to `feed-client.js`.

**Data flow for a reconnect:**

1. Client socket closes → `scheduleReconnect()` fires after backoff delay.
2. New WebSocket opens → `hello { since: lastSeq }` sent.
3. DO reads `storage.list({ start: storageKey(since + 1) })` → sends `history` message.
4. Client applies history through `applyHistory()` — dedup by `id` silently drops anything already seen.
5. Subsequent live `update` messages flow normally.

---

## Technology choices

**Cloudflare Workers + Durable Objects** — a DO gives a single-threaded, single-instance authority per room, which makes assigning a monotonically increasing `seq` race-free with no external locking or coordination. The hibernatable WebSocket API (`ctx.acceptWebSocket` / `ctx.getWebSockets`) means the runtime tracks connected sockets across hibernation — no manual in-memory set to keep consistent.

**No client framework** — the client state logic is a small pure module (`feed-client.js`) with no dependencies. Adding React or similar would add build complexity with no benefit at this scope.

**Alternatives considered:**

- *Server-Sent Events instead of WebSockets* — SSE is simpler for one-way push but doesn't support the client sending `hello`/`publish` over the same connection without a separate HTTP channel.
- *Redis pub/sub for fan-out* — would work but adds an external dependency and a separate ordering problem. The DO eliminates both.
- *Timestamp-based ordering* — rejected because clock skew across clients/servers makes timestamps unreliable as a total order. Server-assigned `seq` is the simplest correct solution.

**Trade-offs accepted:**

- One DO per room means one room's traffic can't be spread across multiple processes. Acceptable at this scale; the path to changing it is described in the "Production and scale" section.
- History is unbounded. Fine for a prototype; a production version needs paging and retention (see below).

---

## Important decisions

**1. Server owns `seq`, client owns dedup.**
`seq` is assigned inside the DO at the moment an update is durably written — never generated client-side. This makes ordering a non-problem: there's one authority, one counter, one total order. Dedup lives client-side (keyed by `id`) because an update can legitimately arrive via both the history replay path and a live push path — the client is the simplest always-correct place to enforce "show each update once."

**2. History is sent before switching to live push, not interleaved.**
On `hello`, the DO computes `getHistorySince(since)` and sends it as one `history` message. Only after that do subsequent `publish` events reach that socket as `update` messages. Because the DO is single-threaded, there's no window where a live update could be constructed and sent to a socket before that socket's own history reply — sequential execution is easier to reason about than buffering and merging two concurrent streams.

**3. Zero-padded storage keys.**
Updates are stored as `msg::0000000001`, `msg::0000000002`, etc. This makes the storage layer's native lexicographic ordering identical to numeric `seq` ordering, which is what makes `storage.list({ start: storageKey(since + 1) })` a correct and efficient cursor-based replay query with no post-sort step.

---

## Assumptions and limitations

- **One room per DO instance** — correct and sufficient for this exercise; not designed for a single room with millions of concurrent users.
- **Unbounded history** — all updates are kept forever. A production version needs paging (`list({ limit })`) and a retention/compaction policy.
- **No authentication** — any client can join any room by name. Out of scope for this exercise.
- **Room names are sanitised client-side** — the sanitisation in `sanitizeRoomId()` is a UX convenience; the server's routing regex is the actual enforcement boundary.
- **In-order delivery assumed** — the DO's single-threaded model and WebSocket's ordered delivery make this safe; it would need revisiting if either changed.

---

## Production and scale

**What the submitted implementation does now:** one DO per room, unbounded history, no auth, no paging, no metrics.

**What I'd change first, in priority order:**

1. **Page history replays.** `getHistorySince` returns everything after the cursor with no limit. Add `list({ start, limit: 500 })` and a `hasMore` flag so a client that's been offline for a long time doesn't receive (or the server doesn't compute) an unbounded payload in one message.

2. **Add a retention window.** Incident feeds have a natural active lifetime (hours to days). A scheduled DO alarm that deletes updates older than N days keeps storage size bounded and keeps replay latency predictable.

3. **Observability before anything else at scale.** Reconnect rate per client, history replay size per reconnect, DO storage size and `list()` latency per room, and broadcast failure counts are the four metrics that would tell you which of the above to prioritise and when.

4. **Auth.** Room names are currently public. Even a simple shared secret per room (passed as a query param on the WebSocket URL, validated in the DO) would be a meaningful improvement before any real use.

5. **Multi-instance fan-out (only if a single room needs it).** Today correctness relies on one DO = one room. If a single room ever needed more throughput than one DO can handle, the `seq` assignment would need to move to an external single-writer log (similar to a Kafka partition), with DO instances only fanning out to their own sockets and forwarding publishes upstream. That's a significant architecture change and not warranted at this scale.

---

## AI usage

Claude was used throughout:

- Scaffolding the initial file structure and wiring (`src/index.ts`, `src/room.ts`, `public/app.js`).
- Suggesting the zero-padded storage key approach for lexicographic/numeric ordering alignment.
- Drafting test cases in `test/live-broadcast.test.ts` for the reconnect + replay scenario.
- UI improvements to `public/index.html` (card layout, status pill, two-column message rows).
- Identifying and fixing the two bugs: stale state across room switches, and room name sanitisation to match the server routing regex.

All AI output was reviewed manually: logic was traced through, types were checked, and the full test suite was run against the real `workerd` runtime to verify correctness. No AI-generated code was committed without being read and understood.

---

## Credibility note

**Project:** Internal developer productivity platform at a mid-size SaaS company — a self-serve environment provisioning tool that let engineers spin up isolated staging environments on demand instead of sharing a single staging server.

**Problem it solved:** The shared staging environment was a constant source of broken deploys and blocked QA cycles. Engineers were stepping on each other's changes, and "who broke staging?" was a daily conversation. The tool gave every engineer (and every PR) their own ephemeral environment, provisioned in under two minutes.

**Personal contribution:** Designed and built the orchestration layer — the service that translated a "create environment" request into the right sequence of infrastructure calls (container scheduling, DNS, secrets injection, health checks) and tracked lifecycle state so environments could be cleanly torn down or rebuilt. Also built the CLI wrapper engineers actually used day-to-day.

**Scale / operational complexity:** ~80 engineers, ~200 environments active at peak, running continuously in production for 18+ months. The orchestration service handled ~500 environment create/destroy cycles per week at peak.

**Difficult decision:** Whether to build environment state as a simple database table (easy to query, hard to make consistent under partial failures) or as an explicit state machine with durable event log (more complex upfront, but partial failures become resumable rather than corrupting). Chose the state machine approach after the first two production incidents where a failed health check left an environment in an ambiguous half-provisioned state with no clean recovery path. The rewrite took a sprint but eliminated that class of incident entirely.

**Public link:** Not publicly available (internal tooling). Code and architecture docs available on request under NDA.
