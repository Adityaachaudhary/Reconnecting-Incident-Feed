import { IncidentRoom } from "./room";

export { IncidentRoom };

export interface Env {
  INCIDENT_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const ROOM_WS_PATH = /^\/api\/rooms\/([a-zA-Z0-9_-]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_WS_PATH);

    if (match) {
      const roomId = match[1];
      const id = env.INCIDENT_ROOM.idFromName(roomId);
      const stub = env.INCIDENT_ROOM.get(id);
      return stub.fetch(request);
    }

    // Everything else is the static client (index.html, app.js, feed-client.js).
    return env.ASSETS.fetch(request);
  },
};
