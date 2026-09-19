// Shared types for the incident feed.
//
// An "Update" is the durable, ordered unit of history for a room.
// `seq` is assigned by the server (the Durable Object) and is the
// single source of truth for ordering and for resume/cursor logic.

export interface Update {
  id: string; // stable, server-assigned unique id (also fine as a natural dedup key)
  roomId: string;
  seq: number; // monotonically increasing per room, assigned by the server
  content: string;
  createdAt: string; // ISO timestamp, informational only — NOT used for ordering
}

// Messages a client sends to the server over the websocket.
export type ClientMessage =
  | { type: "hello"; since?: number }
  | { type: "publish"; content: string };

// Messages the server sends to a client over the websocket.
export type ServerMessage =
  | { type: "history"; updates: Update[] }
  | { type: "update"; update: Update }
  | { type: "error"; message: string };
